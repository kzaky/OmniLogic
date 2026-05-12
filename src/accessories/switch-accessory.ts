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
    // If this accessory was previously a variable-speed Fan (beta-5 and
    // earlier), strip the orphaned Fan service so HomeKit shows just the
    // Switch.
    const oldFan = this.accessory.getService(this.platform.Service.Fan);
    if (oldFan) this.accessory.removeService(oldFan);

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
    const filterSpeed = Number(node['@_filterSpeed']);
    const speed = Number(node['@_speed']);
    const pumpState = Number(node['@_pumpState']);
    const relayState = Number(node['@_relayState']);
    const enableNum = Number(node['@_enable']);
    const enableStr = String(node['@_enable'] ?? '').toLowerCase();
    const on =
      (Number.isFinite(filterSpeed) && filterSpeed > 0) ||
      (Number.isFinite(speed) && speed > 0) ||
      (Number.isFinite(pumpState) && pumpState > 0) ||
      (Number.isFinite(relayState) && relayState > 0) ||
      enableNum === 1 ||
      enableStr === 'yes' ||
      enableStr === 'true' ||
      enableStr === 'on';
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
