import { cellM, geoTransform3857 } from "./frame";
import { writeGeoTiff } from "./geotiff";
import type { NearGrid } from "./lpi";

/** A grid written as the GeoTIFF the layer's exports share. Pure. */

/** A grid as the GeoTIFF the layer's own export writes: EPSG:3857, north up, its metadata. */
export function nearGridTiff(grid: NearGrid): Blob {
  const gt = geoTransform3857(grid.domain);
  const bytes = writeGeoTiff({
    width: grid.size,
    height: grid.size,
    data: grid.values,
    originX: gt.originX,
    originY: gt.originY,
    pixelSize: gt.pixel,
    epsg: 3857,
    noData: grid.nodata,
    // Overwritten in place, so the items keep the layer's own order.
    metadata: { ...grid.metadata, cell_m: String(cellM(grid.domain)) },
  });
  return new Blob([bytes as BlobPart], { type: "image/tiff" });
}
