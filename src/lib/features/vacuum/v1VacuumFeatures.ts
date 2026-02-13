import PQueue from "p-queue";
import { BaseDeviceFeatures, DeviceModelConfig, FeatureDependencies } from "../baseDeviceFeatures";
import { Feature } from "../features.enum";
import { V1ConsumableService } from "./services/V1ConsumableService";
import { V1MapService } from "./services/V1MapService";
import { VACUUM_CONSTANTS } from "./vacuumConstants";

// --- Shared Constants ---
export const BASE_FAN = { 101: "Quiet", 102: "Balanced", 103: "Turbo", 104: "Max" };

export const BASE_WATER = { 200: "Off", 201: "Mild", 202: "Moderate", 203: "Intense" };
export const BASE_MOP = { 300: "Standard", 301: "Deep", 303: "Deep+" };

// --- Profile Interface ---
export interface VacuumProfile {
	mappings: {
		fan_power: Record<number, string>;
		mop_mode?: Record<number, string>;
		water_box_mode?: Record<number, string>;
		error_code?: Record<number, string>;
		state?: Record<number, string>;
	};
	name?: string;
	features?: Record<string, any>;
	cleanMotorModePresets?: Record<string, string>;
	consumableLifeHours?: Record<string, number>;
}

export const DEFAULT_PROFILE: VacuumProfile = {
	mappings: {
		fan_power: BASE_FAN,
		mop_mode: { 300: "Standard", 301: "Deep", 303: "Deep+" },
		water_box_mode: { 200: "Off", 201: "Mild", 202: "Moderate", 203: "Intense" },
	},
};

export class V1VacuumFeatures extends BaseDeviceFeatures {
	protected profile: VacuumProfile = DEFAULT_PROFILE;
	private _consumableService?: V1ConsumableService;
	private _mapService?: V1MapService;

	private get consumableService(): V1ConsumableService {
		if (!this._consumableService) {
			this._consumableService = new V1ConsumableService(this.deps, this.duid, this.profile);
		}
		return this._consumableService;
	}

	private get mapService(): V1MapService {
		if (!this._mapService) {
			this._mapService = new V1MapService(this.deps, this.duid);
		}
		return this._mapService;
	}

	constructor(dependencies: FeatureDependencies, duid: string, robotModel: string, config: DeviceModelConfig = { staticFeatures: [] }, profile: VacuumProfile = DEFAULT_PROFILE) {
		super(dependencies, duid, robotModel, config);


		// Deep clone profile to avoid mutating shared static objects
		this.profile = structuredClone(profile);
	}

	public override async initializeDeviceData(): Promise<void> {
		this.deps.adapter.rLog("System", this.duid, "Info", "1.0", undefined, `[initializeDeviceData] Starting sequential initialization...`, "debug");
		await this.updateMultiMapsList(); // 1. Load Floor List first (for names/metadata)
		await this.updateStatus();        // 2. Get Status (triggers Room sync via first floor detection)
		await this.updateMap();           // 3. Get Map Image

		// These can still be parallel as they don't depend on each other as much
		await Promise.all([
			this.updateFirmwareFeatures(),
			this.updateConsumables(),
			this.updateNetworkInfo(),
			this.updateTimers(),
		]);
		await this.updateConsumablesPercent();
		this.deps.adapter.rLog("System", this.duid, "Info", "1.0", undefined, `[initializeDeviceData] Sequential initialization complete.`, "debug");
	}


	/**
	 * Configures the standard command set for Protocol V1 devices.
	 * @see test/unit/features_specification.test.ts for the core vacuum command list.
	 */
	public override async setupProtocolFeatures(): Promise<void> {
		await super.setupProtocolFeatures();

		// Add Standard V1 Commands
		const translations = this.deps.adapter.translations;

		this.addCommand("app_start", { type: "boolean", role: "button", name: translations["app_start"] || "Start", def: false });
		this.addCommand("app_stop", { type: "boolean", role: "button", name: translations["app_stop"] || "Stop", def: false });
		this.addCommand("app_pause", { type: "boolean", role: "button", name: translations["app_pause"] || "Pause", def: false });
		this.addCommand("app_charge", { type: "boolean", role: "button", name: translations["app_charge"] || "Charge", def: false });
		this.addCommand("find_me", { type: "boolean", role: "button", name: translations["find_me"] || "Find Me", def: false });
		this.addCommand("app_spot", { type: "boolean", role: "button", name: translations["app_spot"] || "Spot Cleaning", def: false });
		this.addCommand("app_segment_clean", { type: "boolean", role: "button", name: "Segment Cleaning", def: false });

		// Restore missing standard V1 commands
		this.addCommand("app_zoned_clean", { type: "json", role: "json", name: "Zone Clean" }); // No default for JSON usually, or "[]"
		this.addCommand("resume_zoned_clean", { type: "boolean", role: "button", name: "Resume Zone Clean", def: false });
		this.addCommand("stop_zoned_clean", { type: "boolean", role: "button", name: "Stop Zone Clean", def: false });

		this.addCommand("resume_segment_clean", { type: "boolean", role: "button", name: "Resume Segment Clean", def: false });
		this.addCommand("stop_segment_clean", { type: "boolean", role: "button", name: "Stop Segment Clean", def: false });

		this.addCommand("app_goto_target", { type: "json", role: "json", name: "Go To Target" });

		this.addCommand("load_multi_map", { type: "number", role: "level", name: "Load Map", def: 0 });



		this.addCommand("set_custom_mode", {
			type: "number",
			role: "level",
			name: translations["fan_power"] || "Fan Power",
			states: this.profile.mappings.fan_power,
			def: Number(Object.keys(this.profile.mappings.fan_power)[0])
		});

		// Consolidated cleaning mode with all parameters (Custom Mode)
		// We define states (Presets) to make it selectable in UI
		this.addCommand("set_clean_motor_mode", {
			type: "string",
			role: "value", // changed from json to value to support dropdown
			name: "Set Custom Cleaning Mode",
			def: this.profile.cleanMotorModePresets ? Object.keys(this.profile.cleanMotorModePresets)[0] : '{"fan_power":102,"mop_mode":300,"water_box_mode":201}',
			states: this.profile.cleanMotorModePresets || {
				'{"fan_power":102,"mop_mode":300,"water_box_mode":201}': "Indv.",
				'{"fan_power":102,"mop_mode":300,"water_box_mode":200}': "Saugen",
				'{"fan_power":105,"mop_mode":303,"water_box_mode":202}': "Wischen",
				'{"fan_power":102,"mop_mode":301,"water_box_mode":201}': "Vac & Mop",
				'{"fan_power":102,"mop_mode":306,"water_box_mode":201}': "Saugen, dann Wischen",
				'{"fan_power":106,"mop_mode":302,"water_box_mode":204}': "Smart Plan"
			}
		});

		if (this.profile.mappings.water_box_mode) {
			this.addCommand("set_water_box_custom_mode", {
				type: "number",
				role: "level",
				name: translations["water_box_mode"] || "Water Box Mode",
				states: this.profile.mappings.water_box_mode,
				def: Number(Object.keys(this.profile.mappings.water_box_mode)[0])
			});
		}

		if (this.profile.mappings.mop_mode) {
			this.addCommand("set_mop_mode", {
				type: "number",
				role: "level",
				name: translations["mop_mode"] || "Mop Mode",
				states: this.profile.mappings.mop_mode,
				def: Number(Object.keys(this.profile.mappings.mop_mode)[0])
			});
		}

		// A101 Specific: Water Box Distance Off (1-30 -> 230-85)
		if (this.profile.features?.hasDistanceOff) {
			this.addCommand("set_water_box_distance_off", {
				type: "number",
				role: "level",
				name: translations["water_box_distance_off"] || "Water Box Distance Off (1-30)",
				min: 1,
				max: 30,
				unit: "",
				def: 1
			});
		}

		this.addCommand("set_clean_repeat_times", {
			type: "number",
			role: "value",
			name: "Clean Repeat Times",
			min: 1,
			max: 2,
			def: 1,
			states: { 1: "1x", 2: "2x" }
		});
	}

	public async detectAndApplyRuntimeFeatures(statusData: Readonly<Record<string, any>>): Promise<boolean> {
		let changed = false;

		// Detect features based on status keys
		if (("clean_area" in statusData || "clean_time" in statusData) && await this.applyFeature(Feature.CleaningRecords)) {
			changed = true;
		}

		if (("map_status" in statusData) && await this.applyFeature(Feature.Map)) {
			changed = true;
		}

		if (statusData["water_shortage_status"] !== undefined && await this.applyFeature(Feature.WaterShortage)) {
			changed = true;
		}

		// Consumables detection (usually static, but can check for keys)
		if (await this.applyFeature(Feature.Consumables)) changed = true;

		// Initial status
		if (statusData["state"] !== undefined) {
			await this.processStatus(statusData);
		}

		if (!this.runtimeDetectionComplete) {
			this.runtimeDetectionComplete = true;
			changed = true;
		}
		return changed;
	}

	@BaseDeviceFeatures.DeviceFeature(Feature.Consumables)
	public async updateConsumables(): Promise<void> {
		await this.consumableService.updateConsumables();
	}

	public async updateConsumablesPercent(): Promise<void> {
		await this.consumableService.updateConsumablesPercent();
	}

	@BaseDeviceFeatures.DeviceFeature(Feature.Map)
	public async updateMap(): Promise<void> {
		await this.mapService.updateMap();
	}

	public async getCleaningRecordMap(startTime: number) {
		return this.mapService.getCleaningRecordMap(startTime);
	}

	@BaseDeviceFeatures.DeviceFeature(Feature.DockingStationStatus)
	protected async createDockingStationStatusStates(): Promise<void> {
		await this.deps.ensureFolder(`Devices.${this.duid}.dockingStationStatus`);

		const commonStates = {
			0: "UNKNOWN",
			1: "ERROR",
			2: "OK"
		};

		const stateDefinitions = [
			{ key: "cleanFluidStatus", name: "Clean Water Tank" },
			{ key: "waterBoxFilterStatus", name: "Water Box Filter" },
			{ key: "dustBagStatus", name: "Dust Bag" },
			{ key: "dirtyWaterBoxStatus", name: "Dirty Water Tank" },
			{ key: "clearWaterBoxStatus", name: "Clear Water Box" },
			{ key: "isUpdownWaterReady", name: "Water Ready Status" }
		];

		for (const stateDef of stateDefinitions) {
			await this.ensureState("dockingStationStatus", stateDef.key, {
				name: stateDef.name,
				type: "number",
				role: "value",
				read: true,
				write: false,
				states: commonStates
			});
		}
	}

	protected async updateDockingStationStatus(dss: number): Promise<void> {
		// guard against invalid payloads
		if (typeof dss !== "number" || Number.isNaN(dss)) {
			return;
		}

		const cleanFluidStatus = (dss & 3) >>> 0;
		const waterBoxFilterStatus = ((dss >> 2) & 3) >>> 0;
		const dustBagStatus = ((dss >> 4) & 3) >>> 0;
		const dirtyWaterBoxStatus = ((dss >> 6) & 3) >>> 0;
		const clearWaterBoxStatus = ((dss >> 8) & 3) >>> 0;
		const isUpdownWaterReady = ((dss >> 10) & 3) >>> 0;

		await this.deps.adapter.setStateAsync(
			`${this.deps.id}.Devices.${this.duid}.dockingStationStatus.cleanFluidStatus`,
			cleanFluidStatus,
			true
		);
		await this.deps.adapter.setStateAsync(
			`${this.deps.id}.Devices.${this.duid}.dockingStationStatus.waterBoxFilterStatus`,
			waterBoxFilterStatus,
			true
		);
		await this.deps.adapter.setStateAsync(
			`${this.deps.id}.Devices.${this.duid}.dockingStationStatus.dustBagStatus`,
			dustBagStatus,
			true
		);
		await this.deps.adapter.setStateAsync(
			`${this.deps.id}.Devices.${this.duid}.dockingStationStatus.dirtyWaterBoxStatus`,
			dirtyWaterBoxStatus,
			true
		);
		await this.deps.adapter.setStateAsync(
			`${this.deps.id}.Devices.${this.duid}.dockingStationStatus.clearWaterBoxStatus`,
			clearWaterBoxStatus,
			true
		);
		await this.deps.adapter.setStateAsync(
			`${this.deps.id}.Devices.${this.duid}.dockingStationStatus.isUpdownWaterReady`,
			isUpdownWaterReady,
			true
		);
	}

	async processStatus(status: any): Promise<void> {
    	const validStatus = status || {};

		if (validStatus.dss !== undefined) {
			await this.updateDockingStationStatus(Number(validStatus.dss));
			delete validStatus.dss;
		}

    	// Define property processing map
    	const processors: Record<string, (val: any) => Promise<void>> = {
    		state: async (val) => {
    			await this.deps.ensureState("deviceStatus.state", { type: "number", states: this.profile.mappings.state || VACUUM_CONSTANTS.stateCodes });
    			await this.deps.adapter.setStateChanged(`Devices.${this.duid}.deviceStatus.state`, { val, ack: true });
    		},
    		error_code: async (val) => {
    			await this.deps.ensureState("deviceStatus.error_code", { type: "number", states: this.profile.mappings.error_code || VACUUM_CONSTANTS.errorCodes });
    			await this.deps.adapter.setStateChanged(`Devices.${this.duid}.deviceStatus.error_code`, { val, ack: true });
    		},
    		fan_power: async (val) => {
    			await this.deps.ensureState("deviceStatus.fan_power", { type: "number", states: this.profile.mappings.fan_power });
    			await this.deps.adapter.setStateChanged(`Devices.${this.duid}.deviceStatus.fan_power`, { val, ack: true });
				// Sync to command state
				await this.deps.adapter.setStateChanged(`Devices.${this.duid}.commands.set_custom_mode`, { val, ack: true });
    		},
    		mop_mode: async (val) => {
    			if (this.profile.mappings.mop_mode) {
    				await this.deps.ensureState("deviceStatus.mop_mode", { type: "number", states: this.profile.mappings.mop_mode });
    				await this.deps.adapter.setStateChanged(`Devices.${this.duid}.deviceStatus.mop_mode`, { val, ack: true });
					// Sync to command state
					await this.deps.adapter.setStateChanged(`Devices.${this.duid}.commands.set_mop_mode`, { val, ack: true });
    			}
    		},
    		water_box_mode: async (val) => {
    			if (this.profile.mappings.water_box_mode) {
    				await this.deps.ensureState("deviceStatus.water_box_mode", { type: "number", states: this.profile.mappings.water_box_mode });
    				await this.deps.adapter.setStateChanged(`Devices.${this.duid}.deviceStatus.water_box_mode`, { val, ack: true });
					// Sync to command state
					await this.deps.adapter.setStateChanged(`Devices.${this.duid}.commands.set_water_box_custom_mode`, { val, ack: true });
    			}
    		}
    	};

    	// Parallel processing of remaining status properties
    	const promises: Promise<void>[] = [];
    	for (const key in validStatus) {
    		if (processors[key]) {
    			promises.push(processors[key](validStatus[key]));
    		} else {
    			// Default handler for generic properties
    			promises.push(this.processResultKey("deviceStatus", key, validStatus[key]));
    		}
    	}

    	await Promise.all(promises);
	}

	protected getDynamicFeatures(): Set<Feature> {
		// v1 dynamic features
		const features = new Set<Feature>();
		if (this.config.staticFeatures) {
			this.config.staticFeatures.forEach(f => features.add(f));
		}
		return features;
	}

	// --- Abstract Method Implementations ---

	public getCommonConsumable(attribute: string | number): Partial<ioBroker.StateCommon> | undefined {
		return (VACUUM_CONSTANTS.consumables as any)[attribute];
	}

	public isResetableConsumable(consumable: string): boolean {
		return VACUUM_CONSTANTS.resetConsumables.has(consumable);
	}

	public getCommonDeviceStates(attribute: string | number): Partial<ioBroker.StateCommon> | undefined {
		return (VACUUM_CONSTANTS.deviceStates as any)[attribute];
	}

	public getCommonCleaningRecords(attribute: string | number): Partial<ioBroker.StateCommon> | undefined {
		return (VACUUM_CONSTANTS.cleaningRecords as any)[attribute];
	}

	public getFirmwareFeatureName(featureID: string | number): string {
		return (VACUUM_CONSTANTS.firmwareFeatures as any)[featureID] || `Feature ${featureID}`;
	}

	public getCommonCleaningInfo(attribute: string | number): Partial<ioBroker.StateCommon> | undefined {
		return (VACUUM_CONSTANTS.cleaningInfo as any)[attribute];
	}

	@BaseDeviceFeatures.DeviceFeature(Feature.AutoEmptyDock)
	public async initAutoEmptyDock(): Promise<void> {
		this.addCommand("app_start_dust_collection", {
			type: "boolean",
			role: "button",
			name: "Empty Dust",
			def: false
		});
	}

	@BaseDeviceFeatures.DeviceFeature(Feature.MopWash)
	public async initMopWash(): Promise<void> {
		this.addCommand("app_start_wash", {
			type: "boolean",
			role: "button",
			name: "Start Mop Wash",
			def: false
		});
		this.addCommand("app_stop_wash", {
			type: "boolean",
			role: "button",
			name: "Stop Mop Wash",
			def: false
		});
	}

	@BaseDeviceFeatures.DeviceFeature(Feature.MopDry)
	public async initMopDry(): Promise<void> {
		this.addCommand("app_start_mop_drying", {
			type: "boolean",
			role: "button",
			name: "Start Mop Drying",
			def: false
		});
		this.addCommand("app_stop_mop_drying", {
			type: "boolean",
			role: "button",
			name: "Stop Mop Drying",
			def: false
		});
	}
	public override async processDockType(dockType: number): Promise<void> {
		const dockFeatureMap: Record<number, Feature[]> = {
			1: [Feature.AutoEmptyDock, Feature.DockingStationStatus],
			2: [Feature.MopWash, Feature.DockingStationStatus],
			3: [Feature.AutoEmptyDock, Feature.MopWash, Feature.DockingStationStatus],
			4: [Feature.AutoEmptyDock, Feature.MopWash, Feature.DockingStationStatus],
			17: [Feature.AutoEmptyDock, Feature.MopWash, Feature.MopDry, Feature.DockingStationStatus]
		};
		const features = dockFeatureMap[dockType];
		if (features) {
			for (const feature of features) {
				await this.applyFeature(feature);
			}
		}
	}

	protected override async processResultKey(folder: string, key: string, val: unknown): Promise<void> {
		if (key === "map_status") {
			const mapIdxChanged = this.mapService.updateCurrentMapIndex(Number(val));

			if (mapIdxChanged) {
				this.deps.adapter.rLog("MapManager", this.duid, "Info", "1.0", undefined, `[MapSync] Map changed to index ${this.mapService.currentIndex}. Updating room mapping.`, "info");
				await this.updateRoomMapping();
			}
		} else if (key === "dock_type") {
			await this.processDockType(Number(val));
		}

		await super.processResultKey(folder, key, val);
		if (key === "dss" && typeof val === "number") {
			await this.updateDockingStationStatus(val);
		}
	}

	public override getCurrentMapIndex(): number {
		return this.mapService.currentIndex;
	}

}
