import { PlatformAccessory, Service } from 'homebridge';
import { OmniLogicPlatform } from '../platform';
import { AccessoryContext } from '../types';
import { TelemetrySnapshot } from '../omnilogic-api';

export abstract class BaseAccessory {
  protected readonly ctx: AccessoryContext;
  private setQueue: Promise<unknown> = Promise.resolve();

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

  protected telemetryNode(snap: TelemetrySnapshot): any | undefined {
    return snap.byId.get(this.ctx.equipmentId);
  }

  protected bowTelemetry(snap: TelemetrySnapshot): any | undefined {
    return snap.byId.get(this.ctx.bowId);
  }

  /**
   * Serialize SET operations on this accessory. HomeKit can fire concurrent
   * SETs for related characteristics (e.g. TargetState + TargetTemperature)
   * which race over OmniLogic's serial protocol; we queue them per accessory
   * so each completes before the next begins.
   */
  protected runSet<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.setQueue.then(fn, fn);
    // Swallow errors from queue chain so a failure doesn't poison later sets.
    this.setQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * Kick a telemetry refresh shortly after a successful SET so HomeKit
   * doesn't show stale state for the full poll interval.
   */
  protected requestPostSetRefresh(delayMs = 1500): void {
    this.platform.scheduleTelemetryRefresh(delayMs);
  }

  abstract setup(): void;
  abstract onTelemetry(snap: TelemetrySnapshot): void;
}
