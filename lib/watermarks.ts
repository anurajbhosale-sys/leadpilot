import { db } from "@/db";
import { watermarkStore } from "@/lib/watermark-store";

export type { WatermarkStore } from "@/lib/watermark-store";

/** Watermarks in the app database. */
export const dbWatermarks = watermarkStore(db);
