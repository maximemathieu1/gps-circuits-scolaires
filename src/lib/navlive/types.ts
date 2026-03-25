export type StopType = "school" | "school_uturn" | "uturn" | "transfer" | "ecole";

export type StopPoint = {
  lat: number;
  lng: number;
  label?: string | null;
  stop_type?: StopType | null;

  note?: string | null;
  note_trigger_m?: number | null;
  note_once?: boolean | null;
  note_images?: string[] | null;
};

export type PointsResp = {
  version_id: string;
  general_note_start?: string | null;
  points: {
    idx: number;
    lat: number;
    lng: number;
    label?: string | null;
    stop_type?: StopType | null;
    note?: string | null;
    note_trigger_m?: number | null;
    note_once?: boolean | null;
    note_images?: string[] | null;
  }[];
};

export type TraceResp = {
  version_id: string;
  points_count: number;
  trail: { idx: number; lat: number; lng: number }[];
  updated_at?: string;
};

export type LatLng = { lat: number; lng: number };