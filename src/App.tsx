import { useState } from "react";
import { BASEMAPS, OSM_ATTRIBUTION } from "./lib/basemaps";
import {
  DEFAULT_BUILDING_SETTINGS,
  PALETTES,
  type BuildingSettings,
} from "./lib/buildings";
import { useMapEngine } from "./lib/useMapEngine";
import { VIEWPOINTS } from "./lib/viewpoints";
import { Compass } from "./ui/Compass";
import { Panel, Slider, Toggle } from "./ui/Panel";

const dms = (value: number, axis: "lat" | "lng") => {
  const hemi = axis === "lat" ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W";
  return `${Math.abs(value).toFixed(4)}° ${hemi}`;
};

export default function App() {
  const [basemapId, setBasemapId] = useState(BASEMAPS[0].id);
  const [settings, setSettings] = useState<BuildingSettings>(DEFAULT_BUILDING_SETTINGS);
  const [activeView, setActiveView] = useState(VIEWPOINTS[0].id);
  const [collapsed, setCollapsed] = useState(false);

  const basemap = BASEMAPS.find((b) => b.id === basemapId) ?? BASEMAPS[0];
  const { containerRef, camera, ready, error, flyTo, zoomBy, setPitch, resetNorth } =
    useMapEngine(basemap, settings);

  const patch = (next: Partial<BuildingSettings>) =>
    setSettings((prev) => ({ ...prev, ...next }));

  const chooseBasemap = (id: string) => {
    const next = BASEMAPS.find((b) => b.id === id);
    if (!next) return;
    setBasemapId(id);
    patch({ flatColor: next.buildingColor });
  };

  return (
    <div className="shell" style={{ ["--accent" as string]: basemap.accent }}>
      <div className="map" ref={containerRef} />
      <div className="atmosphere" aria-hidden />
      <div className="grain" aria-hidden />

      <button
        className="collapse"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        {collapsed ? "Panels" : "Hide"}
      </button>

      <div className="chrome" data-collapsed={collapsed}>
        <aside className="rail" aria-hidden>
          <span className="rail__mark" />
          <span className="rail__legend">GeoLibre 3.0.0 · headless engine</span>
          <span className="rail__ticks">
            {Array.from({ length: 16 }, (_, i) => (
              <i key={i} />
            ))}
          </span>
        </aside>

        <header className="brand">
          <span className="brand__cjk">臺北三維城市</span>
          <div>
            <h1 className="brand__wordmark">
              TAI<em>PEI</em>
            </h1>
            <p className="brand__meta">
              OpenStreetMap buildings · extruded by <b>@geolibre/map</b>
              <br />
              25.04°N 121.56°E · <b>{VIEWPOINTS.length}</b> viewpoints
            </p>
          </div>
        </header>

        <div className={error ? "status status--error" : "status"} role="status">
          <span className="status__dot" aria-hidden />
          {error
            ? `tile error · ${error.slice(0, 48)}`
            : ready
              ? "GeoLibre layer sync · live"
              : "loading OSM vector tiles"}
        </div>

        <div className="stack">
          <Panel index="01" title="Basemap" delay={40}>
            <div className="choices">
              {BASEMAPS.map((b) => (
                <button
                  key={b.id}
                  className="choice"
                  aria-pressed={b.id === basemapId}
                  onClick={() => chooseBasemap(b.id)}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </Panel>

          <Panel index="02" title="Buildings" delay={100}>
            <Toggle
              label="Extrusion"
              on={settings.visible}
              onChange={(visible) => patch({ visible })}
            />
            <Slider
              label="Height ×"
              value={settings.heightScale}
              min={0.2}
              max={4}
              step={0.1}
              onChange={(heightScale) => patch({ heightScale })}
              format={(v) => `${v.toFixed(1)}×`}
            />
            <Slider
              label="Opacity"
              value={settings.opacity}
              min={0.2}
              max={1}
              step={0.02}
              onChange={(opacity) => patch({ opacity })}
              format={(v) => `${Math.round(v * 100)}`}
              unit="%"
            />
            <Slider
              label="Min height"
              value={settings.minHeight}
              min={0}
              max={80}
              step={1}
              onChange={(minHeight) => patch({ minHeight })}
              format={(v) => (v === 0 ? "all" : `${v}`)}
              unit={settings.minHeight === 0 ? undefined : "m"}
            />
            <Toggle
              label="Labels over"
              on={settings.labelsOnTop}
              onChange={(labelsOnTop) => patch({ labelsOnTop })}
            />
          </Panel>

          <Panel index="03" title="Colour ramp" delay={160}>
            <div className="choices">
              {PALETTES.map((p) => (
                <button
                  key={p.id}
                  className="choice choice--swatch"
                  aria-pressed={settings.paletteId === p.id}
                  onClick={() => patch({ paletteId: p.id })}
                >
                  <span
                    className="choice__dot"
                    style={{
                      background: `linear-gradient(135deg, ${p.stops[1][1]}, ${p.stops[4][1]})`,
                    }}
                  />
                  {p.label}
                </button>
              ))}
              <button
                className="choice choice--swatch"
                aria-pressed={settings.paletteId === null}
                onClick={() => patch({ paletteId: null })}
              >
                <span className="choice__dot" style={{ background: settings.flatColor }} />
                Flat
              </button>
            </div>
          </Panel>
        </div>

        <nav className="viewpoints" aria-label="Viewpoints">
          {VIEWPOINTS.map((v, i) => (
            <button
              key={v.id}
              className="viewpoint"
              aria-current={v.id === activeView}
              onClick={() => {
                setActiveView(v.id);
                flyTo(v);
              }}
            >
              <span className="viewpoint__idx">{String(i + 1).padStart(2, "0")}</span>
              <span>
                <span className="viewpoint__name">{v.label}</span>
                <br />
                <span className="viewpoint__sub">{v.sub}</span>
              </span>
            </button>
          ))}
        </nav>

        <div className="dock">
          <div className="pitchbar">
            <span className="pitchbar__cap">Pitch</span>
            <input
              type="range"
              min={0}
              max={85}
              step={1}
              value={Math.round(camera.pitch)}
              aria-label="Camera pitch"
              onChange={(e) => setPitch(Number(e.currentTarget.value))}
            />
          </div>
          <div className="padgroup">
            <button className="pad" onClick={() => zoomBy(1)} aria-label="Zoom in">
              <span className="pad__glyph">+</span>
            </button>
            <button className="pad" onClick={() => zoomBy(-1)} aria-label="Zoom out">
              <span className="pad__glyph">−</span>
            </button>
            <Compass bearing={camera.bearing} onReset={resetNorth} />
          </div>
        </div>

        <footer className="telemetry">
          <div className="readout readout--live">
            <span className="readout__k">Lat</span>
            <span className="readout__v">{dms(camera.lat, "lat")}</span>
          </div>
          <div className="readout readout--live">
            <span className="readout__k">Lon</span>
            <span className="readout__v">{dms(camera.lng, "lng")}</span>
          </div>
          <div className="readout">
            <span className="readout__k">Zoom</span>
            <span className="readout__v">{camera.zoom.toFixed(2)}</span>
          </div>
          <div className="readout">
            <span className="readout__k">Pitch</span>
            <span className="readout__v">{camera.pitch.toFixed(0)}°</span>
          </div>
          <div className="readout">
            <span className="readout__k">Bearing</span>
            <span className="readout__v">
              {(((camera.bearing % 360) + 360) % 360).toFixed(0)}°
            </span>
          </div>
          <div className="readout">
            <span className="readout__k">Source</span>
            <span className="readout__v">OSM · building</span>
          </div>
          <div className="credit">
            <span>{OSM_ATTRIBUTION}</span>
            <a href="https://github.com/opengeos/GeoLibre" target="_blank" rel="noreferrer">
              GeoLibre 3.0.0
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
}
