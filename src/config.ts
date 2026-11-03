/**
 * This module implements the Roon zone configuration of the Remote Two/3 integration driver.
 *
 * @copyright (c) 2024 by Unfolded Circle ApS.
 * @license Mozilla Public License Version 2.0, see LICENSE for more details.
 */

import fs from "fs";
import type { Zone } from "node-roon-api";
import path from "path";

const CFG_FILENAME = "roon_config.json";
const SETTINGS_FILENAME = "roon_settings.json";

interface Settings {
  /** Name of the Roon profile to select after connecting to the Roon Core. Not set: don't change the profile. */
  profile?: string;
}

class Config {
  private zones: { [key: string]: Zone } = {};
  private readonly configPath: string;
  private settings: Settings = {};
  private readonly settingsPath: string;

  constructor(configDir: string) {
    this.configPath = path.join(configDir, CFG_FILENAME);
    this.settingsPath = path.join(configDir, SETTINGS_FILENAME);
    this.loadFromFile();
    this.loadSettings();
  }

  /** Name of the Roon profile to use, or `undefined` to keep the profile selected in Roon. */
  public getProfile(): string | undefined {
    return this.settings.profile || undefined;
  }

  public setProfile(profile: string | undefined) {
    this.settings.profile = profile || undefined;
    fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), "utf-8");
  }

  private loadSettings() {
    try {
      if (fs.existsSync(this.settingsPath)) {
        this.settings = JSON.parse(fs.readFileSync(this.settingsPath, "utf-8"));
      }
    } catch {
      this.settings = {};
    }
  }

  public updateZone(zone: Zone) {
    this.zones[zone.zone_id] = zone;
    this.saveToFile();
  }

  public clear() {
    this.zones = {};
    this.saveToFile();
  }

  public hasZone(zoneId: string): boolean {
    const zone = this.getZone(zoneId);
    return !!zone;
  }

  public getZone(zoneId: string): Zone | null {
    return this.zones[zoneId] ?? null;
  }

  public forEachZone(callback: (zone: Zone) => void) {
    for (const zone of this.getAllZones()) {
      callback(zone);
    }
  }

  private getAllZones(): Zone[] {
    return Object.values(this.zones);
  }

  private loadFromFile() {
    if (fs.existsSync(this.configPath)) {
      const data = fs.readFileSync(this.configPath, "utf-8");
      this.zones = JSON.parse(data);
    } else {
      this.saveToFile();
    }
  }

  private saveToFile() {
    const data = JSON.stringify(this.zones, null, 2);
    fs.writeFileSync(this.configPath, data, "utf-8");
  }
}

export default Config;
