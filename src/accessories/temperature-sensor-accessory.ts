import { Service } from 'homebridge';
import { BaseAccessory } from './base-accessory';
import { TelemetrySnapshot } from '../omnilogic-api';

export class TemperatureSensorAccessory extends BaseAccessory {
  private service!: Service;
  private currentTempC = 20;

  setup(): void {
    this.service = this.getOrAddService(
      this.platform.Service.TemperatureSensor,
    );
    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      this.ctx.name,
    );
    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 100, minStep: 0.1 })
      .onGet(() => this.currentTempC);
  }

  onTelemetry(snap: TelemetrySnapshot): void {
    const bow = this.bowTelemetry(snap);
    if (!bow) return;
    const tempF =
      Number(bow['@_waterTemp']) ||
      Number(bow['@_temp']) ||
      Number(bow['@_currentTemp']);
    if (!Number.isFinite(tempF) || tempF <= 0) return;
    this.currentTempC = Math.round(((tempF - 32) * 5) / 9 * 10) / 10;
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      this.currentTempC,
    );
  }
}
