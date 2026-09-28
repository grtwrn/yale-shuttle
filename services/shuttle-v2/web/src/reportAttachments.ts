// Shared browser/server limits. Images are downscaled before upload.
export const REPORT_IMAGE_MAX_COUNT = 5;
export const REPORT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const REPORT_IMAGES_MAX_BYTES = 6 * 1024 * 1024;
export const REPORT_IMAGES_MAX_DATA_URL_LENGTH = 4 * Math.ceil(REPORT_IMAGES_MAX_BYTES / 3) + 200;
