import * as THREE from "three";
import type { CustomRenderMethodInput } from "maplibre-gl";
import type { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { decomposeCamera, mercatorFrame, projection, ThreeLayer } from "../../lib/three";
import {
  groundFootprint,
  frameAt,
  planTiles,
  TileStore,
  type LocalFrame,
  type TileSource,
} from "../../lib/tiles";
import { placeCapture, rebased, type Anchor, type Placed } from "./frame";
import {
  SPLAT_BLUR_AMOUNT,
  SPLAT_FETCH_HALF_M,
  SPLAT_MIN_ZOOM,
  SPLAT_NATIVE_LAYER_ID,
} from "./constants";
import {
  lodUrlOf,
  splatsIn,
  splatTiles,
  type Splat,
  type SplatSource,
} from "./schema";
import { splatStatus, type SplatStatus } from "./state";
import { Residency } from "./residency";
import { makeStretch, type Stretch } from "./stretch";

type Spark = typeof import("@sparkjsdev/spark");

/** What the layer reaches outside itself; tests replace them. */
export interface SplatLayerDeps {
  /** Spark, imported on first need: ~2.6 MB that a session without captures never loads. */
  importSpark: () => Promise<Spark>;
  fetchFn: typeof fetch;
  /** The view's ground footprint, as lng/lat. */
  footprint: (map: NonNullable<ThreeSplatLayer["map"]>) => [number, number][];
  /** The tile adapter; tests decode without MVT. */
  tiles: (source: SplatSource) => TileSource<Splat>;
}

const DEFAULT_DEPS: SplatLayerDeps = {
  importSpark: () => import("@sparkjsdev/spark"),
  fetchFn: (...a) => fetch(...a),
  footprint: groundFootprint,
  tiles: splatTiles,
};

/** What the layer holds per loaded capture; `Residency` holds the rest. */
interface Drawn {
  mesh: SplatMesh;
  /** The per-axis scale, applied by Spark about the capture's origin. */
  stretch: Stretch;
}

/**
 * Gaussian splat captures, drawn with Spark on the base's renderer. The camera
 * is MapLibre's, split into view and projection by `decomposeCamera`, because
 * Spark needs view space. See `specs/spec.md`.
 *
 * No `prerender`: Spark's own GPU work runs from `SparkRenderer.onBeforeRender`,
 * inside `renderer.render`, inside `pass`.
 */
export class ThreeSplatLayer extends ThreeLayer {
  readonly id = SPLAT_NATIVE_LAYER_ID;

  onStatus: ((status: SplatStatus) => void) | null = null;

  private readonly deps: SplatLayerDeps;
  private readonly store: TileStore<{ splats: TileSource<Splat> }>;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private spark: Spark | null = null;
  private sparkRenderer: SparkRenderer | null = null;

  private visible = false;
  private opacity = 1;
  private minZoom = SPLAT_MIN_ZOOM;
  private snapToGround = true;
  /** Spark's LoD budget: `null` is its platform default. See *Settings*. */
  private lodSplatCount: number | null = null;
  private lodSplatScale = 1;

  /** Which captures are loaded, queued and failed. See *Which captures load*. */
  private readonly residency = new Residency<Drawn>();
  /** The frame at the view's centre at the last plan: what distances are measured from. */
  private view: LocalFrame = { origin: { x: 0, y: 0 }, metre: 1 };
  private anchor: Anchor | null = null;
  private disposed = false;

  constructor(
    private readonly source: SplatSource,
    deps: Partial<SplatLayerDeps> = {},
  ) {
    super();
    this.deps = { ...DEFAULT_DEPS, ...deps };
    this.store = new TileStore({ splats: this.deps.tiles(source) }, this.deps.fetchFn);
    this.store.onChange = () => this.collect();
    // `render` sets both world matrices from `decomposeCamera`'s view; three
    // must not derive one from the other again.
    this.camera.matrixAutoUpdate = false;
    this.camera.matrixWorldAutoUpdate = false;
  }

  setVisibility(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.plan();
    this.repaint();
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
    for (const { value } of this.residency.held()) value.mesh.opacity = opacity;
    this.repaint();
  }

  /** Spark redoes the LoD when the budget changes, on the next frame. */
  setLod(lodSplatCount: number | null, lodSplatScale: number): void {
    this.lodSplatCount = lodSplatCount;
    this.lodSplatScale = lodSplatScale;
    if (this.sparkRenderer) {
      this.sparkRenderer.lodSplatCount = lodSplatCount ?? undefined;
      this.sparkRenderer.lodSplatScale = lodSplatScale;
    }
    this.repaint();
  }

  /** Re-place every held capture on its own ground or the shared one. */
  setSnapToGround(snap: boolean): void {
    if (snap === this.snapToGround) return;
    this.snapToGround = snap;
    if (this.anchor) this.replaceHeld(this.anchor);
  }

  setMinZoom(minZoom: number): void {
    this.minZoom = minZoom;
    this.plan();
    this.repaint();
  }

  protected contextChanged(renderer: THREE.WebGLRenderer): void {
    // Spark's renderer holds targets on the old context.
    this.dropSparkRenderer();
    if (this.spark) this.makeSparkRenderer(renderer);
  }

  protected attached(): void {
    this.plan();
  }

  protected viewSettled(): void {
    this.rebase();
    this.plan();
    this.unloadFar();
  }

  render(_gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    const anchor = this.anchor;
    if (!anchor || !this.drawing() || !this.sparkRenderer || this.residency.held().length === 0) return;
    const { projection: p, view } = decomposeCamera(projection(args, mercatorFrame(anchor.origin, anchor.metre)));
    // Spark reads the projection and `matrixWorld`; three's renderer reads
    // `matrixWorldInverse`, which is the view itself. Nothing reads
    // `projectionMatrixInverse`, so it is not computed.
    this.camera.projectionMatrix.copy(p);
    this.camera.matrixWorldInverse.copy(view);
    this.camera.matrixWorld.copy(view).invert();
    this.pass((renderer) => renderer.render(this.scene, this.camera));
  }

  dispose(): void {
    this.disposed = true;
    this.store.dispose();
    for (const { value } of this.residency.clear()) value.mesh.dispose();
    this.dropSparkRenderer();
    super.dispose();
  }

  /** Shown, and close enough that a capture is worth its size. */
  private drawing(): boolean {
    return this.visible && (this.map?.getZoom() ?? 0) >= this.minZoom;
  }

  /**
   * Move the anchor to the view centre once the centre is past `SPLAT_REBASE_M`
   * from it (`rebased`), and re-place every capture. Only ever on a settled
   * view: the meshes' world transforms must not change while the camera moves.
   */
  private rebase(): void {
    const map = this.map;
    if (!map || !this.anchor) return;
    const c = map.getCenter();
    const next = rebased(this.anchor, c.lng, c.lat);
    if (!next) return;
    this.anchor = next;
    this.replaceHeld(next);
  }

  /** Re-place every held capture from `anchor`, and ask for a frame. */
  private replaceHeld(anchor: Anchor): void {
    for (const { splat, value } of this.residency.held()) this.apply(value, this.place(splat, anchor));
    this.repaint();
  }

  /** `placeCapture` with the ground `snapToGround` chooses. */
  private place(splat: Splat, anchor: Anchor): Placed {
    return placeCapture(splat, anchor, this.snapToGround ? splat.groundZ : this.source.sharedGroundZ);
  }

  /** Put a capture's mesh and its stretch where `placeCapture` says. */
  private apply(l: Drawn, placed: Placed): void {
    l.mesh.matrix.copy(placed.matrix);
    l.mesh.matrixWorldNeedsUpdate = true;
    l.stretch.setOrigin(placed.origin);
    // The modifier's uniform changed: Spark regenerates on a new version.
    l.mesh.updateVersion();
  }

  /** Ask the store for the view's tiles. Nothing at all while not drawing. */
  private plan(): void {
    const map = this.map;
    if (!map || !this.drawing()) return;
    const c = map.getCenter();
    this.view = frameAt(c.lng, c.lat);
    this.anchor ??= this.view;
    this.store.want(planTiles(this.view, this.deps.footprint(map), SPLAT_FETCH_HALF_M));
    this.collect();
  }

  /** Queue every newly seen capture, nearest first, and start the next load. */
  private collect(): void {
    const perTile = this.store.covered().map((t) => this.store.featuresOf("splats", t));
    if (this.residency.offer(splatsIn(perTile, this.view.origin))) this.report();
    void this.pump();
  }

  /**
   * Unload what `Residency.settle` says is too far. Only on a settled view
   * that is drawing: a hidden layer keeps what it has, and Spark frees an
   * unrendered capture's pages itself. See *Which captures load*.
   */
  private unloadFar(): void {
    if (!this.drawing()) return;
    const { unloaded, changed } = this.residency.settle(this.view);
    for (const { value } of unloaded) this.unload(value);
    if (changed) this.report();
  }

  /**
   * Remove a capture from the scene and dispose it. Spark gives its pages back
   * to the pool at its next LoD update, once it has gone unrendered for
   * `lodCleanupTimeoutMs`; `dispose` alone does not.
   */
  private unload({ mesh }: Drawn): void {
    this.scene.remove(mesh);
    mesh.dispose();
    this.repaint();
  }

  /** Load what `Residency.next` says, one capture at a time, until it says wait. */
  private async pump(): Promise<void> {
    if (this.disposed || !this.drawing()) return;
    const next = this.residency.next(this.view);
    if (!next) return;
    const { load: splat, evicted } = next;
    if (evicted) this.unload(evicted.value);
    this.report();
    try {
      const spark = await this.ensureSpark();
      // The paged LoD tree built in infra: Spark fetches its chunks as the view
      // needs them, into a pool of fixed size. See *Level of detail*.
      const stretch = makeStretch(spark.dyno, this.place(splat, this.anchor!).axes);
      const mesh = new spark.SplatMesh({
        url: lodUrlOf(this.source, splat),
        paged: true,
        worldModifier: stretch.modifier,
      });
      await mesh.initialized;
      if (this.disposed) {
        mesh.dispose();
        return;
      }
      mesh.matrixAutoUpdate = false;
      mesh.opacity = this.opacity;
      const drawn: Drawn = { mesh, stretch };
      // Placed from the anchor now, which may have moved during the load.
      this.apply(drawn, this.place(splat, this.anchor!));
      this.scene.add(mesh);
      this.residency.done(splat, drawn);
    } catch (e) {
      this.residency.failed(splat, e instanceof Error ? e.message : String(e));
    }
    this.report();
    this.repaint();
    void this.pump();
  }

  private async ensureSpark(): Promise<Spark> {
    if (!this.spark) {
      this.spark = await this.deps.importSpark();
      if (this.renderer && !this.sparkRenderer) this.makeSparkRenderer(this.renderer);
      // The platform budget is known from here on.
      this.report();
    }
    return this.spark;
  }

  private makeSparkRenderer(renderer: THREE.WebGLRenderer): void {
    this.sparkRenderer = new this.spark!.SparkRenderer({
      renderer,
      // A sort or a load finished. The only repaint the layer asks for, so the
      // map still goes idle when nothing changes.
      onDirty: () => this.repaint(),
      blurAmount: SPLAT_BLUR_AMOUNT,
      // Draw a per-view budget of splats from every capture's paged tree. The
      // page pool (`maxPagedSplats`) and `lodCleanupTimeoutMs` stay Spark's
      // defaults: the pool bounds what is held, and the timeout is what gives
      // an unloaded or hidden capture's pages back.
      enableLod: true,
      lodSplatCount: this.lodSplatCount ?? undefined,
      lodSplatScale: this.lodSplatScale,
    });
    this.scene.add(this.sparkRenderer);
  }

  private dropSparkRenderer(): void {
    if (!this.sparkRenderer) return;
    this.scene.remove(this.sparkRenderer);
    this.sparkRenderer.dispose();
    this.sparkRenderer = null;
  }

  private report(): void {
    this.onStatus?.(
      splatStatus({
        ...this.residency.counts(),
        platformBudget: this.sparkRenderer?.defaultSplatTarget() ?? null,
      }),
    );
  }
}
