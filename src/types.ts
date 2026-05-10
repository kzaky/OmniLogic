import { PlatformConfig } from 'homebridge';

export interface OmniLogicPlatformConfig extends PlatformConfig {
  username: string;
  password: string;
  pollIntervalSeconds?: number;
  temperatureUnits?: 'F' | 'C';
  exposeChlorinator?: boolean;
  exposePumps?: boolean;
  exposeLights?: boolean;
  exposeHeaters?: boolean;
  debug?: boolean;
}

export interface AccessoryContext {
  kind: 'heater' | 'light' | 'pump' | 'filter' | 'chlorinator' | 'temperature';
  mspSystemId: number;
  bowId: number;
  equipmentId: number;
  bowName: string;
  name: string;
}
