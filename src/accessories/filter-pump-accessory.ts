import { CharacteristicValue, Service } from 'homebridge';
import { BaseAccessory } from './base-accessory';
import { TelemetrySnapshot } from '../omnilogic-api';

/**
 * Variable-speed filter pump exposed as a Fan with rotation speed = % of max.
 * On/Off maps to speed 0 vs. the last non-zero speed (default 100).
 */
export class FilterPumpAccessory extends BaseAccessory {
  private service!: Service;
  private isOn = false;
  private speed = 100;
  private lastNonZeroSpeed = 100;

  setup(): void {
    this.service = this.getOrAddService(this.platform.Service.Fan);
    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      this.ctx.name,
    );

    this.service
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.isOn)
      .onSet(this.handleOnSet.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(() => this.speed)
      .onSet(this.handleSpeedSet.bind(this));
  }

  onTelemetry(snap: TelemetrySnapshot): void {
    const node = this.telemetryNode(snap);
    if (!node) return;
    const reported =
      Number(node['@_filterSpeed']) ||
      Number(node['@_speed']) ||
      Number(node['@_pumpSpeed']);
    if (Number.isFinite(reported)) {
      this.speed = Math.max(0, Math.min(100, reported));
      this.isOn = this.speed > 0;
      if (this.speed > 0) this.lastNonZeroSpeed = this.speed;
      this.service.updateCharacteristic(
        this.platform.Characteristic.On,
        this.isOn,
      );
      this.service.updateCharacteristic(
        this.platform.Characteristic.RotationSpeed,
        this.speed,
      );
    }
  }

  private async handleOnSet(value: CharacteristicValue): Promise<void> {
    const on = !!value;
    const desired = on ? this.lastNonZeroSpeed || 100 : 0;
    await this.applySpeed(desired);
  }

  private async handleSpeedSet(value: CharacteristicValue): Promise<void> {
    const desired = Number(value);
    if (desired > 0) this.lastNonZeroSpeed = desired;
    await this.applySpeed(desired);
  }

  private async applySpeed(speed: number): Promise<void> {
    this.speed = speed;
    this.isOn = speed > 0;
    await this.runSet(async () => {
      try {
        await this.platform.api.setFilterSpeed(
          this.ctx.mspSystemId,
          this.ctx.bowId,
          this.ctx.equipmentId,
          speed,
        );
        this.requestPostSetRefresh();
      } catch (err: any) {
        this.platform.log.error('Filter speed set failed:', err.message);
        throw err;
      }
    });
  }
}
