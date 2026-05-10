import { CharacteristicValue, Service } from 'homebridge';
import { BaseAccessory } from './base-accessory';
import { TelemetrySnapshot } from '../omnilogic-api';

/**
 * ColorLogic light. Modeled as a Lightbulb with on/off. "Off" sends show 0,
 * "on" restores the last-known show (default Voodoo Lounge / 1).
 */
export class LightAccessory extends BaseAccessory {
  private service!: Service;
  private isOn = false;
  private lastShow = 1;

  setup(): void {
    this.service = this.getOrAddService(this.platform.Service.Lightbulb);
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
    const state =
      Number(node['@_lightState']) ||
      Number(node['@_state']) ||
      Number(node['@_speed']);
    const show = Number(node['@_currentShow']);
    if (Number.isFinite(show) && show > 0) this.lastShow = show;
    const on = state > 0 || (Number.isFinite(show) && show > 0);
    this.isOn = on;
    this.service.updateCharacteristic(this.platform.Characteristic.On, on);
  }

  private async handleOnSet(value: CharacteristicValue): Promise<void> {
    const on = !!value;
    this.isOn = on;
    await this.runSet(async () => {
      try {
        await this.platform.api.setLightShow(
          this.ctx.mspSystemId,
          this.ctx.bowId,
          this.ctx.equipmentId,
          on ? this.lastShow : 0,
        );
        this.requestPostSetRefresh();
      } catch (err: any) {
        this.platform.log.error('Light set failed:', err.message);
        throw err;
      }
    });
  }
}
