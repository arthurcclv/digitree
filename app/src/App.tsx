import { useState } from "react";
import { BASEMAPS, OSM_ATTRIBUTION } from "./layers/basemaps";
import { DEFAULT_BUILDING_SETTINGS, type BuildingSettings } from "./layers/buildings";
import {
  DEFAULT_TREE_SETTINGS,
  MODELS_ATTRIBUTION,
  TREES_ATTRIBUTION,
  TREES_MIN_ZOOM,
  TREES_TOTAL,
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
import { useMapEngine } from "./lib/useMapEngine";
import { VIEWPOINTS } from "./lib/viewpoints";
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

const dms = (value: number, axis: "lat" | "lng") => {
  const hemi = axis === "lat" ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W";
  return `${Math.abs(value).toFixed(4)}° ${hemi}`;
};

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

/** The tile readout: the covered count, then what is loading or failed. */
const tilesText = ({ covered, pending, failed }: TileCounts): string =>
  `${covered}` + (pending ? ` · ${pending} loading` : "") + (failed ? ` · ${failed} failed` : "");

/** `direct-sun-20260621T0400Z.tif` for the export's sun time. */
const exportName = (sunTime: number): string =>
  `direct-sun-${new Date(sunTime).toISOString().replace(/[:]/g, "").slice(0, 15)}Z.tif`;

const probeText = (p: ProbeResult | null): string => {
  if (!p) return "click the map";
  switch (p.kind) {
    case "value":
      return p.index.toFixed(3);
    case "roof":
      return "roof, not ground";
    case "incomplete":
      return "incomplete here";
    case "outside":
      return "outside the computed area";
    default:
      return "no result";
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
  const [exporting, setExporting] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [activeView, setActiveView] = useState(VIEWPOINTS[0].id);
  const [collapsed, setCollapsed] = useState(false);

  const basemap = BASEMAPS.find((b) => b.id === basemapId) ?? BASEMAPS[0];
  const {
    containerRef,
    camera,
    ready,
    error,
    modelStatus,
    sunlightStatus,
    exportSunlight,
    flyTo,
    zoomBy,
    setPitch,
    resetNorth,
  } = useMapEngine(basemap, settings, tree, sun, setProbe);

  const patchSun = (next: Partial<SunlightSettings>) => {
    // A probe answers for one computed result; a new sun or the overlay
    // switching makes it stale.
    if ("sunTime" in next || "visible" in next) setProbe(null);
    setSun((prev) => ({ ...prev, ...next }));
  };

  const sunState = sunlightStatus?.state ?? "off";
  const sunMinutes = taipeiMinutes(sun.sunTime);

  const downloadSunlight = async () => {
    setExporting(true);
    try {
      const blob = await exportSunlight();
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = exportName(sun.sunTime);
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

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

  const bearing = (((camera.bearing % 360) + 360) % 360).toFixed(0);

  return (
    <div className="app-shell" data-collapsed={collapsed}>
      <header className="top-bar">
        <span className="top-bar__title">Taipei 3D</span>
        <span className="top-bar__sub">OpenStreetMap buildings · GeoLibre 3.0.0 headless</span>
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
              label="Labels over buildings"
              checked={settings.labelsOnTop}
              onChange={(labelsOnTop) => patch({ labelsOnTop })}
              title="Off by default: labels styled for a dark ground are unreadable over lit building faces."
            />
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
            <StatLine k="Surveyed trees" v={TREES_TOTAL.toLocaleString("en-US")} />
            <StatLine k="Points from" v={`z${TREES_MIN_ZOOM}`} />
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
                  {
                    id: "labels",
                    label: "Labels over buildings",
                    checked: settings.labelsOnTop,
                    onChange: (labelsOnTop) => patch({ labelsOnTop }),
                  },
                ]}
              />
            </div>
          </div>

          {/* Required whenever the map is visible — see the basemaps spec. The
              tree inventory is a second source and so a second obligation. */}
          <div className="map-credit">
            <span>{OSM_ATTRIBUTION}</span>
            <span>{TREES_ATTRIBUTION}</span>
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

        <div className="column column--right">
          <Panel title="Viewpoints">
            <nav className="viewpoints" aria-label="Viewpoints">
              {VIEWPOINTS.map((v) => (
                <button
                  key={v.id}
                  className="viewpoint-row"
                  aria-current={v.id === activeView}
                  onClick={() => {
                    setActiveView(v.id);
                    flyTo(v);
                  }}
                >
                  <span className="viewpoint-row__check" aria-hidden>
                    ✓
                  </span>
                  <span>
                    <span className="viewpoint-row__name">{v.label}</span>
                    <span className="viewpoint-row__sub">{v.sub}</span>
                  </span>
                  <span className="viewpoint-row__rate">z{v.zoom.toFixed(1)}</span>
                </button>
              ))}
            </nav>
          </Panel>

          <Panel title="Camera">
            <div className="stat-list">
              <StatLine k="Lat" v={dms(camera.lat, "lat")} />
              <StatLine k="Lon" v={dms(camera.lng, "lng")} />
              <StatLine k="Zoom" v={camera.zoom.toFixed(2)} />
              <StatLine k="Bearing" v={`${bearing}°`} />
              <StatLine k="Source" v="OSM · building" plain />
            </div>
            <div className="panel__rule" />
            <Slider
              label="Pitch"
              value={Math.round(camera.pitch)}
              min={0}
              max={85}
              step={1}
              unit="°"
              onChange={setPitch}
            />
          </Panel>
        </div>
      </div>
    </div>
  );
}
