import { useState } from "react";
import { BASEMAPS, OSM_ATTRIBUTION } from "./layers/basemaps";
import { DEFAULT_BUILDING_SETTINGS, type BuildingSettings } from "./layers/buildings";
import {
  AO_INTENSITY_MAX,
  AO_MIN_ZOOM,
  AO_RADIUS_MAX_M,
  AO_RADIUS_MIN_M,
  DEFAULT_AO_SETTINGS,
  type AmbientOcclusionSettings,
  type AoState,
} from "./layers/ambient-occlusion";
import {
  DEFAULT_TREE_SETTINGS,
  MODELS_ATTRIBUTION,
  TREE_MESH_MIN_ZOOM,
  type TreeKindFilter,
  type TreeMeshSource,
  type TreeSettings,
} from "./layers/tree";
import {
  DEFAULT_SUNLIGHT_SETTINGS,
  fromTaipei,
  MIN_SUN_ELEVATION_DEG,
  SUN_TIME_MAX,
  SUN_TIME_MIN,
  SUN_TIME_STEP,
  SUNLIGHT_MIN_ZOOM,
  taipeiDate,
  taipeiMinutes,
  type ProbeResult,
  type SunlightSettings,
  type SunlightState,
  type TileCounts,
} from "./layers/sunlight";
import {
  DEFAULT_TEMPERATURE_SETTINGS,
  PET_PARAM_RANGES,
  type PetProbe,
  type TemperatureSettings,
} from "./layers/temperature";
import { useMapEngine } from "./lib/useMapEngine";
import { TREES, TREES_SURVEYED } from "./sources";
import { cameraReadout } from "./ui/cameraReadout";
import { Compass } from "./ui/Compass";
import { LayerMenu } from "./ui/LayerMenu";
import {
  Badge,
  CheckboxRow,
  Panel,
  Segmented,
  Slider,
  Spinner,
  StatLine,
  type SegmentedItem,
} from "./ui/Panel";

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** Why nothing is drawn, in the panel's words. `ready` says nothing. */
const SUNLIGHT_STATE_TEXT: Record<SunlightState, string | null> = {
  off: null,
  zoom: `zoom in to z${SUNLIGHT_MIN_ZOOM}`,
  "low-sun": `sun below ${MIN_SUN_ELEVATION_DEG}°`,
  unsupported: "GPU lacks float targets",
  waiting: "computing…",
  ready: null,
};

/** Why no occlusion is drawn, in the panel's words. */
const AO_STATE_TEXT: Record<AoState, string | null> = {
  off: null,
  zoom: `zoom in to z${AO_MIN_ZOOM}`,
  unsupported: "GPU lacks float targets",
  ready: null,
};

/** The tile readout: the covered count, then what is loading or failed. */
const tilesText = ({ covered, pending, failed }: TileCounts): string =>
  `${covered}` + (pending ? ` · ${pending} loading` : "") + (failed ? ` · ${failed} failed` : "");

/** `direct-sun-20260621T0400Z.tif` for the export's sun time. */
const exportName = (sunTime: number): string =>
  `direct-sun-${new Date(sunTime).toISOString().replace(/[:]/g, "").slice(0, 15)}Z.tif`;

/** `pet-20260621T0400Z.tif` for the export's sun time. */
const petExportName = (sunTime: number): string =>
  `pet-${new Date(sunTime).toISOString().replace(/[:]/g, "").slice(0, 15)}Z.tif`;

/** A probe's non-value answers, shared by both overlays. */
const probeKindText = (kind: "roof" | "incomplete" | "outside" | "none"): string =>
  ({
    roof: "roof, not ground",
    incomplete: "incomplete here",
    outside: "outside the computed area",
    none: "no result",
  })[kind];

const petProbeText = (p: PetProbe | null): string => {
  if (!p) return "click the map";
  return p.kind === "value" ? `${p.pet.toFixed(1)} °C · ${p.cls}` : probeKindText(p.kind);
};

const probeText = (p: ProbeResult | null): string => {
  if (!p) return "click the map";
  switch (p.kind) {
    case "value":
      return p.index.toFixed(3);
    default:
      return probeKindText(p.kind);
  }
};

const basemapItems: SegmentedItem[] = BASEMAPS.map((b) => ({ id: b.id, label: b.label }));

const treeKindItems: SegmentedItem[] = [
  { id: "all", label: "All" },
  { id: "street", label: "Street" },
  { id: "park", label: "Park" },
  // Selects nothing when no drop-in data is loaded, which is the honest
  // outcome: an empty result for an empty dataset, not a hidden control.
  { id: "custom", label: "Custom" },
];

// Not "Real". A modelled tree is a stock beech or spruce picked for its
// silhouette, not a portrait of the 榕樹 at that coordinate — what is real
// under either source is the position and the surveyed height.
const treeSourceItems: SegmentedItem[] = [
  { id: "procedural", label: "Generated" },
  { id: "model", label: "Modelled" },
];

export default function App() {
  const [basemapId, setBasemapId] = useState(BASEMAPS[0].id);
  const [settings, setSettings] = useState<BuildingSettings>(DEFAULT_BUILDING_SETTINGS);
  const [tree, setTree] = useState<TreeSettings>(DEFAULT_TREE_SETTINGS);
  const [sun, setSun] = useState<SunlightSettings>(DEFAULT_SUNLIGHT_SETTINGS);
  const [ao, setAo] = useState<AmbientOcclusionSettings>(DEFAULT_AO_SETTINGS);
  const [exporting, setExporting] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [temp, setTemp] = useState<TemperatureSettings>(DEFAULT_TEMPERATURE_SETTINGS);
  const [petProbe, setPetProbe] = useState<PetProbe | null>(null);
  const [exportingPet, setExportingPet] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const basemap = BASEMAPS.find((b) => b.id === basemapId) ?? BASEMAPS[0];
  const {
    containerRef,
    camera,
    ready,
    error,
    modelStatus,
    sunlightStatus,
    aoState,
    temperatureStatus,
    exportSunlight,
    exportTemperature,
    zoomBy,
    resetNorth,
  } = useMapEngine(basemap, settings, tree, sun, ao, temp, setProbe, setPetProbe);

  const patchAo = (next: Partial<AmbientOcclusionSettings>) => setAo((prev) => ({ ...prev, ...next }));

  const patchSun = (next: Partial<SunlightSettings>) => {
    // A probe answers for one computed result; a new sun or the overlay
    // switching makes it stale.
    if ("sunTime" in next || "visible" in next) {
      setProbe(null);
      setPetProbe(null);
    }
    setSun((prev) => ({ ...prev, ...next }));
  };

  const patchTemp = (next: Partial<TemperatureSettings>) => {
    // Every field but opacity changes what a PET probe answered.
    if (Object.keys(next).some((k) => k !== "opacity")) setPetProbe(null);
    setTemp((prev) => ({ ...prev, ...next }));
  };

  const petState = temperatureStatus?.state ?? "off";

  const sunState = sunlightStatus?.state ?? "off";
  const sunMinutes = taipeiMinutes(sun.sunTime);

  const download = async (
    read: () => Promise<Blob | null>,
    name: string,
    setBusy: (busy: boolean) => void,
  ) => {
    setBusy(true);
    try {
      const blob = await read();
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };
  const downloadSunlight = () => download(exportSunlight, exportName(sun.sunTime), setExporting);
  const downloadTemperature = () => download(exportTemperature, petExportName(sun.sunTime), setExportingPet);

  const patch = (next: Partial<BuildingSettings>) =>
    setSettings((prev) => ({ ...prev, ...next }));

  const patchTree = (next: Partial<TreeSettings>) =>
    setTree((prev) => ({ ...prev, ...next }));

  const chooseBasemap = (id: string) => {
    const next = BASEMAPS.find((b) => b.id === id);
    if (!next) return;
    setBasemapId(id);
    patch({ flatColor: next.buildingColor });
  };

  return (
    <div className="app-shell" data-collapsed={collapsed}>
      <header className="top-bar">
        <span className="top-bar__title">Digitree</span>
        <div className="top-bar__right">
          {ready ? (
            <Badge tone={error ? "tile-error" : "sync"}>
              {error ? "tiles incomplete" : "layer sync live"}
            </Badge>
          ) : (
            <Badge tone="loading">
              <Spinner />
              loading tiles
            </Badge>
          )}
          <button
            className="btn secondary top-bar__collapse"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
          >
            {collapsed ? "Panels" : "Hide"}
          </button>
        </div>
      </header>

      <div className="app">
        <div className="column column--left">
          {/* Red means nothing is drawing; amber means it draws but is
              incomplete. The two must never be styled alike. */}
          {error && !ready ? (
            <div className="error-banner" role="alert">
              The map style failed to load — {error}
            </div>
          ) : null}
          {error && ready ? (
            <div className="warning-banner" role="status">
              Some tiles did not load — {error}
            </div>
          ) : null}

          <Panel title="Basemap">
            <Segmented
              items={basemapItems}
              value={basemapId}
              columns={4}
              label="Basemap"
              onChange={chooseBasemap}
            />
          </Panel>

          <Panel title="Buildings">
            <CheckboxRow
              label="Extrusion"
              checked={settings.visible}
              onChange={(visible) => patch({ visible })}
            />
            <Slider
              label="Height exaggeration"
              value={settings.heightScale}
              min={0.2}
              max={4}
              step={0.1}
              decimals={1}
              unit="×"
              title="Vertical exaggeration. The minimum-height filter still reads true height."
              onChange={(heightScale) => patch({ heightScale })}
            />
            <Slider
              label="Opacity"
              value={Math.round(settings.opacity * 100)}
              min={20}
              max={100}
              step={2}
              unit="%"
              onChange={(v) => patch({ opacity: v / 100 })}
            />
            <Slider
              label="Min height"
              value={settings.minHeight}
              min={0}
              max={80}
              step={1}
              unit="m"
              title="Hide buildings shorter than this, in real metres."
              onChange={(minHeight) => patch({ minHeight })}
            />
            <CheckboxRow
              label="Ambient occlusion"
              checked={ao.enabled}
              onChange={(enabled) => patchAo({ enabled })}
              title="Darkens inner corners, narrow gaps and the ground at the foot of walls."
            />
            {ao.enabled ? (
              <>
                <Slider
                  label="Intensity"
                  value={Math.round(ao.intensity * 100)}
                  min={0}
                  max={AO_INTENSITY_MAX * 100}
                  step={5}
                  unit="%"
                  title="100% multiplies by the occlusion; above it the darkening is steeper and saturates at black."
                  onChange={(v) => patchAo({ intensity: v / 100 })}
                />
                <Slider
                  label="Radius"
                  value={ao.radiusM}
                  min={AO_RADIUS_MIN_M}
                  max={AO_RADIUS_MAX_M}
                  step={1}
                  unit="m"
                  title="How far from a wall the occlusion reaches, in ground metres."
                  onChange={(radiusM) => patchAo({ radiusM })}
                />
                {settings.visible && AO_STATE_TEXT[aoState] ? (
                  <StatLine k="Occlusion" v={AO_STATE_TEXT[aoState]!} plain />
                ) : null}
              </>
            ) : null}
          </Panel>

          <Panel title="Trees">
            <CheckboxRow
              label="Points"
              checked={tree.pointsVisible}
              onChange={(pointsVisible) => patchTree({ pointsVisible })}
            />
            <CheckboxRow
              label="3D meshes"
              checked={tree.meshVisible}
              onChange={(meshVisible) => patchTree({ meshVisible })}
            />
            <Segmented
              label="Mesh source"
              items={treeSourceItems}
              columns={2}
              value={tree.meshSource}
              onChange={(id) => patchTree({ meshSource: id as TreeMeshSource })}
            />
            <Segmented
              label="Tree kind"
              items={treeKindItems}
              columns={4}
              value={tree.kind}
              onChange={(kind) => patchTree({ kind: kind as TreeKindFilter })}
            />
            <Slider
              label="Opacity"
              value={Math.round(tree.opacity * 100)}
              min={10}
              max={100}
              step={2}
              unit="%"
              onChange={(v) => patchTree({ opacity: v / 100 })}
            />
            <Slider
              label="Height scale"
              value={tree.heightScale}
              min={0.5}
              max={4}
              step={0.1}
              decimals={1}
              unit="×"
              title="Exaggerates each tree's surveyed height. 1.0 is true scale."
              onChange={(heightScale) => patchTree({ heightScale })}
            />
            <div className="panel__rule" />
            {/* The inventory's size, not what is in view: the drawn count moves
                with the viewport and would read as data changing. */}
            <StatLine k="Surveyed trees" v={TREES_SURVEYED.toLocaleString("en-US")} />
            <StatLine k="Points from" v={`z${TREES.minzoom}`} />
            <StatLine k="Meshes from" v={`z${TREE_MESH_MIN_ZOOM}`} />
            {/* Models arrive one at a time and a form that never arrives keeps
                drawing generated, so the count is the only way to see it. */}
            {tree.meshSource === "model" ? (
              <StatLine
                k="Modelled forms"
                v={
                  modelStatus.total === 0
                    ? "loading…"
                    : `${modelStatus.loaded}/${modelStatus.total}` +
                      (modelStatus.failed ? ` · ${modelStatus.failed} failed` : "")
                }
              />
            ) : null}
          </Panel>

          <Panel title="Direct sun">
            <CheckboxRow
              label="Overlay"
              checked={sun.visible}
              onChange={(visible) => patchSun({ visible })}
              title="Fraction of direct sunlight reaching the ground through trees and past buildings. Diffuse skylight is not included."
            />
            <label className="field__row field-date">
              <span className="field__label">Date</span>
              <input
                type="date"
                value={taipeiDate(sun.sunTime)}
                onChange={(e) => {
                  const date = e.currentTarget.value;
                  if (date) patchSun({ sunTime: fromTaipei(date, sunMinutes) });
                }}
              />
            </label>
            <Slider
              label="Time (Taipei)"
              value={sunMinutes / 60}
              min={SUN_TIME_MIN / 60}
              max={SUN_TIME_MAX / 60}
              step={SUN_TIME_STEP / 60}
              decimals={2}
              unit="h"
              title="Local time in Asia/Taipei (UTC+8)."
              onChange={(h) =>
                patchSun({ sunTime: fromTaipei(taipeiDate(sun.sunTime), Math.round(h * 60)) })
              }
            />
            <Slider
              label="Opacity"
              value={Math.round(sun.opacity * 100)}
              min={10}
              max={100}
              step={2}
              unit="%"
              onChange={(v) => patchSun({ opacity: v / 100 })}
            />
            <div className="panel__rule" />
            <StatLine k="Local time" v={`${hhmm(sunMinutes)} +08`} />
            {sunlightStatus ? (
              <StatLine
                k="Sun"
                v={`az ${sunlightStatus.azimuthDeg.toFixed(1)}° · el ${sunlightStatus.elevationDeg.toFixed(1)}°`}
              />
            ) : null}
            {sun.visible && SUNLIGHT_STATE_TEXT[sunState] ? (
              <StatLine k="State" v={SUNLIGHT_STATE_TEXT[sunState]!} plain />
            ) : null}
            {sun.visible && (sunState === "ready" || sunState === "waiting") && sunlightStatus ? (
              <>
                <StatLine k="Cell" v={`${sunlightStatus.cellM.toFixed(2)} m`} />
                <StatLine k="Tiles" v={tilesText(sunlightStatus.tiles)} />
                <StatLine
                  k="Occluders"
                  v={`${sunlightStatus.trees.toLocaleString("en-US")} trees · ${sunlightStatus.buildings.toLocaleString("en-US")} bldg`}
                />
                <StatLine k="Direct sun here" v={probeText(probe)} />
              </>
            ) : null}
            <button
              className="btn secondary"
              disabled={!sun.visible || sunState !== "ready" || exporting}
              onClick={downloadSunlight}
            >
              {exporting ? "Exporting…" : "Export GeoTIFF"}
            </button>
          </Panel>

          <Panel title="Felt temperature (PET)">
            <CheckboxRow
              label="Overlay"
              checked={temp.visible}
              onChange={(visible) => patchTemp({ visible })}
              title="Physiological equivalent temperature, derived from the direct-sun index. Not air temperature."
            />
            <Slider
              label="G0 · global irradiance"
              value={temp.g0}
              {...PET_PARAM_RANGES.g0}
              unit="W/m²"
              onChange={(g0) => patchTemp({ g0 })}
            />
            <Slider
              label="Ta · air temperature"
              value={temp.ta}
              {...PET_PARAM_RANGES.ta}
              decimals={1}
              unit="°C"
              onChange={(ta) => patchTemp({ ta })}
            />
            <Slider
              label="V · wind speed"
              value={temp.v}
              {...PET_PARAM_RANGES.v}
              decimals={1}
              unit="m/s"
              onChange={(v) => patchTemp({ v })}
            />
            <Slider
              label="Opacity"
              value={Math.round(temp.opacity * 100)}
              min={10}
              max={100}
              step={5}
              unit="%"
              onChange={(v) => patchTemp({ opacity: v / 100 })}
            />
            <div className="panel__rule" />
            {temperatureStatus ? (
              <StatLine
                k="PET shade → sun"
                v={`${temperatureStatus.petRange[0].toFixed(1)} → ${temperatureStatus.petRange[1].toFixed(1)} °C`}
              />
            ) : null}
            <StatLine k="Sun time" v="set in Direct sun" plain />
            {temp.visible && SUNLIGHT_STATE_TEXT[petState] ? (
              <StatLine k="State" v={SUNLIGHT_STATE_TEXT[petState]!} plain />
            ) : null}
            {temp.visible && petState === "ready" ? (
              <StatLine k="PET here" v={petProbeText(petProbe)} />
            ) : null}
            <button
              className="btn secondary"
              disabled={!temp.visible || petState !== "ready" || exportingPet}
              onClick={downloadTemperature}
            >
              {exportingPet ? "Exporting…" : "Export GeoTIFF"}
            </button>
          </Panel>
        </div>

        <div className="viewport">
          <div className="map" ref={containerRef} />

          <div className="viewport-toolbar viewport-toolbar--left">
            <div className="toolbar-group">
              <button className="icon-btn" onClick={() => zoomBy(1)} aria-label="Zoom in" title="Zoom in">
                +
              </button>
              <button className="icon-btn" onClick={() => zoomBy(-1)} aria-label="Zoom out" title="Zoom out">
                −
              </button>
            </div>
            <div className="toolbar-group">
              <Compass bearing={camera.bearing} onReset={resetNorth} />
            </div>
          </div>

          <div className="viewport-toolbar viewport-toolbar--right">
            <div className="toolbar-group">
              <LayerMenu
                layers={[
                  {
                    id: "buildings",
                    label: "Buildings",
                    checked: settings.visible,
                    onChange: (visible) => patch({ visible }),
                  },
                  {
                    id: "tree-points",
                    label: "Tree points",
                    checked: tree.pointsVisible,
                    onChange: (pointsVisible) => patchTree({ pointsVisible }),
                  },
                  {
                    id: "tree-mesh",
                    label: "Tree meshes",
                    checked: tree.meshVisible,
                    onChange: (meshVisible) => patchTree({ meshVisible }),
                  },
                ]}
              />
            </div>
          </div>

          {/* Required whenever the map is visible — see the basemaps spec. The
              tree inventory is a second source and so a second obligation. */}
          <div className="map-credit">
            <span>{OSM_ATTRIBUTION}</span>
            <span>{TREES.attribution}</span>
            {/* Conditional where the other two are not: the obligation exists
                only while the CC BY models are the ones being drawn. */}
            {tree.meshVisible && tree.meshSource === "model" ? (
              <span>{MODELS_ATTRIBUTION}</span>
            ) : null}
            <a href="https://github.com/opengeos/GeoLibre" target="_blank" rel="noreferrer">
              GeoLibre 3.0.0
            </a>
          </div>
        </div>

      </div>

      <footer className="status-bar" aria-label="Camera">
        {cameraReadout(camera).map(({ k, v }, i) => (
          <span key={i} className="status-bar__item">
            {k ? <span className="status-bar__k">{k} </span> : null}
            <span className="status-bar__v">{v}</span>
          </span>
        ))}
      </footer>
    </div>
  );
}
