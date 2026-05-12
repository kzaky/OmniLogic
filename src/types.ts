import { PlatformConfig } from 'homebridge';

export interface OmniLogicPlatformConfig extends PlatformConfig {
  username: string;
  password: string;
  pollIntervalSeconds?: number;
  temperatureUnits?: 'F' | 'C';
  exposeChlorinator?: boolean;
  exposeRelays?: boolean;
  exposePumps?: boolean;
  exposeLights?: boolean;
  exposeHeaters?: boolean;
  hideEquipmentIds?: number[];
  debug?: boolean;
  disableLogs?: boolean;
}

export interface AccessoryContext {
  kind: 'heater' | 'light' | 'pump' | 'filter' | 'chlorinator' | 'relay' | 'temperature';
  mspSystemId: number;
  bowId: number;
  equipmentId: number;
  bowName: string;
  name: string;
}
