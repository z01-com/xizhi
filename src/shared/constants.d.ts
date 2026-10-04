export declare const APP_NAME = "\u9010\u6D6A\u5B57\u5320";
export declare const APP_NAME_EN = "ZoomlaXizhi";
export declare const APP_VER = "1.0.0";
export declare const UI_FONT = "Microsoft YaHei";
export declare const COLORS: {
    BG: string;
    CARD: string;
    BORDER: string;
    ACCENT: string;
    ACCENT_D: string;
    GREEN: string;
    GREEN_D: string;
    TEXT: string;
    TEXT_DARK: string;
    TEXT_LIGHT: string;
    SELECT: string;
    SELECT_BORDER: string;
    GRID_LIGHT: string;
    GRID_DARK: string;
    BASELINE: string;
    ASCENT: string;
    DESCENT: string;
    EM_BOX: string;
    ON_POINT: string;
    OFF_POINT: string;
    OUTLINE: string;
    FILL: string;
    PROGRESS: string;
    PROGRESS_BG: string;
};
export declare const EXPORT_SIZES: number[];
export declare const EXPORT_FORMATS: string[];
export declare const DEFAULT_THUMB_SIZE = 120;
export declare const DEFAULT_PAGE_SIZE = 200;
export declare const FONT_METRICS: {
    UPM: number;
    ASCENT: number;
    DESCENT: number;
};
export declare const HOTKEY_ACTIONS: {
    id: string;
    name: string;
    default: string;
}[];
export declare const DB_TABLES: {
    LOG: string;
    SETTING: string;
    PROD_RECORD: string;
    EDITOR_STATE: string;
};
export declare const ILLEGAL_FN_CHARS: Set<string>;
export declare const MAX_PROD_RECORDS = 200;
export declare const MAX_UNDO_STEPS = 50;
export declare const CANVAS_MARGIN = 50;
export declare const ZOOM_MIN = 0.2;
export declare const ZOOM_MAX = 5;
export declare const TOOLS: {
    SELECT: string;
    BRUSH: string;
    ERASER: string;
};
export declare const FX_EXT_SCHEMA: ({
    id: string;
    name: string;
    type: string;
    default: string;
    defEn?: undefined;
    defZh?: undefined;
} | {
    id: number;
    name: string;
    type: string;
    defEn: string;
    defZh: string;
    default?: undefined;
} | {
    id: number;
    name: string;
    type: string;
    defEn: string;
    default?: undefined;
    defZh?: undefined;
})[];
//# sourceMappingURL=constants.d.ts.map
