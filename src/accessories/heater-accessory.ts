import { CharacteristicValue, Service } from 'homebridge';
import { BaseAccessory } from './base-accessory';
import { TelemetrySnapshot } from '../omnilogic-api';

const F_MIN = 50;
const F_MAX = 104;

export class HeaterAccessory extends BaseAccessory {
  private service!: Service;
  private currentTempC = 20;
  private targetTempC = 26;
  private enabled = false;

  setup(): void {
    this.service = this.getOrAddService(this.platform.Service.Thermostat);
    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      this.ctx.name,
    );

    this.service
      .getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [
          this.platform.Characteristic.TargetHeatingCoolingState.OFF,
          this.platform.Characteristic.TargetHeatingCoolingState.HEAT,
        ],
      })
      .onGet(() =>
        this.enabled
          ? this.platform.Characteristic.TargetHeatingCoolingState.HEAT
          : this.platform.Characteristic.TargetHeatingCoolingState.OFF,
      )
      .onSet(this.handleTargetStateSet.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .setProps({
        validValues: [
          this.platform.Characteristic.CurrentHeatingCoolingState.OFF,
          this.platform.Characteristic.CurrentHeatingCoolingState.HEAT,
        ],
      });

    const minC = this.fToC(F_MIN);
    const maxC = this.fToC(F_MAX);
    this.service
      .getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .setProps({ minValue: minC, maxValue: maxC, minStep: 0.5 })
      .onGet(() => this.targetTempC)
      .onSet(this.handleTargetTempSet.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(() => this.currentTempC);

    const wantsF = (this.platform.config.temperatureUnits ?? 'F') === 'F';
    this.service.setCharacteristic(
      this.platform.Characteristic.TemperatureDisplayUnits,
      wantsF
        ? this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT
        : this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS,
    );
  }

  onTelemetry(snap: TelemetrySnapshot): void {
    const node = this.telemetryNode(snap);
    const bow = this.bowTelemetry(snap);
    if (!node && !bow) return;

    const reportedF =
      Number(node?.['@_temp']) ||
      Number(bow?.['@_waterTemp']) ||
      Number(bow?.['@_temp']);
    const setpointF =
      Number(node?.['@_Current-Set-Point']) ||
      Number(node?.['@_currentSetPoint']) ||
      Number(node?.['@_settingsTemp']);
    const enabled =
      Number(node?.['@_enable']) === 1 ||
      String(node?.['@_enable']).toLowerCase() === 'true' ||
      Number(node?.['@_heaterState']) === 1;

    if (Number.isFinite(reportedF) && reportedF > 0) {
      this.currentTempC = this.fToC(reportedF);
      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentTemperature,
        this.currentTempC,
      );
    }
    if (Number.isFinite(setpointF) && setpointF > 0) {
      this.targetTempC = this.fToC(setpointF);
      this.service.updateCharacteristic(
        this.platform.Characteristic.TargetTemperature,
        this.targetTempC,
      );
    }
    this.enabled = enabled;
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentHeatingCoolingState,
      enabled
        ? this.platform.Characteristic.CurrentHeatingCoolingState.HEAT
        : this.platform.Characteristic.CurrentHeatingCoolingState.OFF,
    );
    this.service.updateCharacteristic(
      this.platform.Characteristic.TargetHeatingCoolingState,
      enabled
        ? this.platform.Characteristic.TargetHeatingCoolingState.HEAT
        : this.platform.Characteristic.TargetHeatingCoolingState.OFF,
    );
  }

  private async handleTargetStateSet(value: CharacteristicValue): Promise<void> {
    const want =
      value === this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
    this.enabled = want;
    await this.runSet(async () => {
      try {
        await this.platform.api.setHeaterEnable(
          this.ctx.mspSystemId,
          this.ctx.bowId,
          this.ctx.equipmentId,
          want,
        );
        this.requestPostSetRefresh();
      } catch (err: any) {
        this.platform.log.error('Heater enable failed:', err.message);
        throw err;
      }
    });
  }

  private async handleTargetTempSet(value: CharacteristicValue): Promise<void> {
    const tempC = Number(value);
    this.targetTempC = tempC;
    const tempF = this.cToF(tempC);
    await this.runSet(async () => {
      try {
        await this.platform.api.setHeaterSetpoint(
          this.ctx.mspSystemId,
          this.ctx.bowId,
          this.ctx.equipmentId,
          tempF,
        );
        this.requestPostSetRefresh();
      } catch (err: any) {
        this.platform.log.error('Heater setpoint failed:', err.message);
        throw err;
      }
    });
  }

  private fToC(f: number): number {
    return Math.round((((f - 32) * 5) / 9) * 2) / 2;
  }

  private cToF(c: number): number {
    return Math.round((c * 9) / 5 + 32);
  }
}
