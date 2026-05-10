import { CharacteristicValue, Service } from 'homebridge';
import { BaseAccessory } from './base-accessory';
import { TelemetrySnapshot } from '../omnilogic-api';

/**
 * Generic on/off equipment (pumps, chlorinator, relays).
 */
export class SwitchAccessory extends BaseAccessory {
  private service!: Service;
  private isOn = false;

  setup(): void {
    this.service = this.getOrAddService(this.platform.Service.Switch);
    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      this.ctx.name,
    );
    this.service
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.isOn)
      .onSet(this.handleOnSet.bind(this));
  }

  onTelemetry(snap: TelemetrySnapshot): void {
    const node = this.telemetryNode(snap);
    if (!node) return;
    const speed = Number(node['@_speed']) || Number(node['@_filterSpeed']);
    const state =
      Number(node['@_pumpState']) ||
      Number(node['@_relayState']) ||
      Number(node['@_state']) ||
      Number(node['@_status']);
    const operatingMode = Number(node['@_operatingMode']);
    const on = (Number.isFinite(speed) && speed > 0) ||
      (Number.isFinite(state) && state > 0) ||
      (Number.isFinite(operatingMode) && operatingMode > 0);
    this.isOn = on;
    this.service.updateCharacteristic(this.platform.Characteristic.On, on);
  }

  private async handleOnSet(value: CharacteristicValue): Promise<void> {
    const on = !!value;
    this.isOn = on;
    await this.runApiSet(`${this.ctx.name} set`, () =>
      this.platform.api.setEquipmentState(
        this.ctx.mspSystemId,
        this.ctx.bowId,
        this.ctx.equipmentId,
        on,
      ),
    );
  }
}
