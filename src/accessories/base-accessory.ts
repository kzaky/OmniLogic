import { PlatformAccessory, Service } from 'homebridge';
import { OmniLogicPlatform } from '../platform';
import { AccessoryContext } from '../types';
import { TelemetrySnapshot } from '../omnilogic-api';

export abstract class BaseAccessory {
  protected readonly ctx: AccessoryContext;

  constructor(
    protected readonly platform: OmniLogicPlatform,
    protected readonly accessory: PlatformAccessory<AccessoryContext>,
  ) {
    this.ctx = accessory.context;
    this.setInformation();
    this.setup();
    if (platform.latestTelemetry) {
      this.onTelemetry(platform.latestTelemetry);
    }
  }

  protected setInformation(): void {
    const info =
      this.accessory.getService(this.platform.Service.AccessoryInformation) ??
      this.accessory.addService(this.platform.Service.AccessoryInformation);

    info
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Hayward')
      .setCharacteristic(
        this.platform.Characteristic.Model,
        `OmniLogic ${this.ctx.kind}`,
      )
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        `${this.ctx.mspSystemId}-${this.ctx.equipmentId}`,
      );
  }

  protected getOrAddService(type: typeof Service | any): Service {
    return (
      this.accessory.getService(type) ?? this.accessory.addService(type)
    );
  }

  /**
   * Find this accessory's data within a telemetry snapshot. Hayward returns
   * a flat list of <BodyOfWater>, <Heater>, <Filter>, etc. nodes each with a
   * `systemId` attribute. We look up by the equipmentId we recorded at
   * discovery time.
   */
  protected telemetryNode(snap: TelemetrySnapshot): any | undefined {
    return snap.byId.get(this.ctx.equipmentId);
  }

  protected bowTelemetry(snap: TelemetrySnapshot): any | undefined {
    return snap.byId.get(this.ctx.bowId);
  }

  abstract setup(): void;
  abstract onTelemetry(snap: TelemetrySnapshot): void;
}
