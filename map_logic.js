// map_logic.js

// --- Constants ---
const GEOJSON_FILE_PATHS = [
'scans_nara.geojson',
'scans_ign.geojson',
'scans_barch.geojson',
//'scans_wur.geojson' // for later
];
const PARSE_WORKER_PATH = 'parse_worker.js';
const FILTER_WORKER_PATH = 'filter_worker.js';
const DATE_PROPERTY_NAME = 'date'; // Assumes 'date' is the common property name after parsing
const DEBOUNCE_DELAY = 300;
const SLIDER_MIN_DATE_STR = '1939-01-01';
const SLIDER_MAX_DATE_STR = '1947-12-31';
const LARGE_DATASET_THRESHOLD = 1000;
const DEFAULT_EMPTY_MAP_VIEW = [20, 0];
const DEFAULT_EMPTY_MAP_ZOOM = 2;
const LOADER_HIDE_DELAY = 100;

// --- DOM Element References (initialized in DOMContentLoaded) ---
let domElements = {};

// --- Map & Layer Variables ---
let map;
let markerClusterGroup;
let fullGeoJsonData;

// --- Worker Variables ---
let activeFilterWorker = null;

// --- Date Filter Variables ---
let currentStartDateEpoch, currentEndDateEpoch;
let debounceTimer;
let sliderMinEpoch, sliderMaxEpoch;

// --- Loader Text Generators (for Leaflet.MarkerCluster chunk progress) ---
let chunkProgressTextGenerator = (p, t) => `Processing features: ${Math.round((p/t)*100)}% (${p}/${t})`;
let chunkFinalizeTextGenerator = () => `Finalizing features...`;

function normalizeDegrees(degrees) {
let normalized = degrees % 360; // Ensure it's within a 360-degree cycle, handling values > 360 or < 0
if (normalized > 180) {
normalized -= 360;
} else if (normalized < -180) { // Should not happen if input is 0-360, but good for robustness
normalized += 360;
}
return normalized;
}

// --- UI Update Functions ---
function updateLoaderText(message) {
if (domElements.loaderText) domElements.loaderText.textContent = message;
}

function showLoader(showSpinner = true, showProgressBar = false, text = "Loading...") {
if (!domElements.loaderContainer) return;
updateLoaderText(text);
domElements.loaderContainer.classList.remove('hidden');
if (domElements.spinner) domElements.spinner.classList.toggle('hidden', !showSpinner);
if (domElements.progressInfo) domElements.progressInfo.classList.toggle('hidden', !showProgressBar);
if (domElements.progressBarContainer) domElements.progressBarContainer.classList.toggle('hidden', !showProgressBar);
}

function hideLoader(delay = LOADER_HIDE_DELAY) {
if (!domElements.loaderContainer || domElements.loaderContainer.classList.contains('hidden')) return;
setTimeout(() => {
if (domElements.loaderContainer) {
domElements.loaderContainer.classList.add('hidden');
}
}, delay);
}

// --- Date Helper Functions (used on main thread) ---
function getEpochFromDateString(dateStr, atTime = 'start') {
if (!dateStr) return NaN;
let fullDateStr = dateStr;
if (atTime === 'start') fullDateStr += 'T00:00:00.000Z';
else if (atTime === 'end') fullDateStr += 'T23:59:59.999Z';
return new Date(fullDateStr).getTime();
}

function formatDateEpochToInput(epochMs) {
if (epochMs === null || epochMs === undefined || isNaN(epochMs)) return '';
const date = new Date(epochMs);
const year = date.getUTCFullYear();
const month = String(date.getUTCMonth() + 1).padStart(2, '0');
const day = String(date.getUTCDate()).padStart(2, '0');
return `${year}-${month}-${day}`;
}

// --- GeoTIFF Preview Logic ---
async function _internal_loadAndRenderGeoTiffPreview(url, canvasId, statusId, imageFilename) {
const canvas = document.getElementById(canvasId);
const statusElement = document.getElementById(statusId);

function updateDisplayState(isLoadingOrError, message = "") {
    if (canvas) {
        canvas.style.display = isLoadingOrError ? 'none' : 'block';
    }
    if (statusElement) {
        if (isLoadingOrError) {
            statusElement.textContent = message;
            statusElement.style.display = 'block';
        } else {
            statusElement.remove(); // Remove status element on success
        }
    }
}

if (!canvas) {
    console.error(`[GeoTIFF] Preview canvas with ID '${canvasId}' not found.`);
    if (statusElement) updateDisplayState(true, 'Error: Canvas element not found.');
    return;
}
// If canvas is already rendered and status is gone, do nothing
if (!statusElement && canvas && canvas.style.display === 'block' && canvas.width > 0 && canvas.height > 0) {
    return;
}

if (!window.GeoTIFF) {
    updateDisplayState(true, 'Error: GeoTIFF library not loaded.');
    console.error('[GeoTIFF] GeoTIFF library (geotiff.js) not found.');
    return;
}

try {
    updateDisplayState(true, 'Fetching GeoTIFF metadata...');
    const tiff = await GeoTIFF.fromUrl(url);
    const imageCount = await tiff.getImageCount();

    if (imageCount === 0) {
        throw new Error("No images found in GeoTIFF.");
    }

    let imageToLoadIndex;
    // Try to load a lower-resolution overview (often the last images are overviews)
    // e.g., if imageCount is 5, try index 2 (imageCount - 3).
    // If fewer than 3, take the last one. If only 1, take the first (index 0).
    if (imageCount - 3 >= 0) { imageToLoadIndex = imageCount - 3; }
    else if (imageCount > 1) { imageToLoadIndex = imageCount - 1; }
    else { imageToLoadIndex = 0; }
    
    updateDisplayState(true, `Loading overview ${imageToLoadIndex + 1} of ${imageCount}...`);
    const image = await tiff.getImage(imageToLoadIndex);

    canvas.width = image.getWidth();
    canvas.height = image.getHeight();
    
    const rasterData = await image.readRasters();
    updateDisplayState(true, 'Rendering preview...');

    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(canvas.width, canvas.height);
    const data = imageData.data;

    if (rasterData.length === 0) { throw new Error("No raster data found in the selected image/overview."); }
    
    // Assuming single band (grayscale) for simplicity.
    // For RGB, you'd handle rasterData[0], rasterData[1], rasterData[2].
    const band = rasterData[0]; // Or iterate through bands if it's an array of bands
    if (rasterData.length >= 1) { // At least one band
        for (let i = 0; i < band.length; i++) {
          const value = band[i];
          data[i * 4] = value;     // R
          data[i * 4 + 1] = value; // G
          data[i * 4 + 2] = value; // B
          data[i * 4 + 3] = 255;   // Alpha (fully opaque)
        }
    } else {
        // This case should ideally be caught by rasterData.length === 0
        throw new Error(`Unsupported raster data format (bands: ${rasterData.length}).`);
    }

    ctx.putImageData(imageData, 0, 0);
    updateDisplayState(false); // Success, hide status, show canvas

} catch (error) {
    console.error(`[GeoTIFF] Error loading preview for ${imageFilename || url}:`, error);
    updateDisplayState(true, `Failed to load preview: ${error.message}.`);
}


}

// --- NARA IIIF Preview Logic ---
/**

Generates unique element IDs for NARA IIIF preview.

IDs are now deterministic based on naId.

@param {object} properties Feature properties, expected to have 'naId'.

@returns {object} { imageId: string, statusId: string }
*/
function getNaraPreviewElementIds(properties) {
// Sanitize naId to ensure it's a valid part of a DOM ID
// Replace invalid characters (not alphanumeric, underscore, or hyphen) with an underscore.
const idBase = properties && properties.naId ? String(properties.naId).replace(/[^a-zA-Z0-9_-]/g, '_') : 'nara-unknown';
return {
imageId: `nara-preview-image-${idBase}`,
statusId: `nara-preview-status-${idBase}`
};
}

/**

Generates a NARA IIIF preview image URL.

@param {string} objectURL The original NARA object URL.

@returns {Promise<string|null>} A promise that resolves to the preview image URL or null.
*/
async function getNaraIiifPreviewUrl(objectURL) {
try {
const naraProdStorageMarker = "NARAprodstorage/";
const markerIndex = objectURL.indexOf(naraProdStorageMarker);

if (markerIndex === -1) {
     console.warn("[NARA IIIF] Marker 'NARAprodstorage/' not found in objectURL:", objectURL);
     return null;
 }

 const filePathIdentifier = objectURL.substring(markerIndex + naraProdStorageMarker.length);
 if (!filePathIdentifier) {
     console.warn("[NARA IIIF] Could not extract file path identifier from objectURL:", objectURL);
     return null;
 }

 const encodedIiifIdentifier = encodeURIComponent(filePathIdentifier);
 const infoJsonUrl = `https://catalog.archives.gov/iiif/3/${encodedIiifIdentifier}/info.json`;

 const response = await fetch(infoJsonUrl);
 if (!response.ok) {
     console.warn(`[NARA IIIF] Error fetching info.json (${response.status}) from ${infoJsonUrl}. Response:`, await response.text());
     return null;
 }
 const imageInfo = await response.json();

 if (typeof imageInfo.width !== 'number' || typeof imageInfo.height !== 'number') {
     console.warn("[NARA IIIF] Original image width/height not found in info.json:", imageInfo);
     return null;
 }
 const originalWidth = imageInfo.width;
 const originalHeight = imageInfo.height;

 if (!imageInfo.sizes || !Array.isArray(imageInfo.sizes)) {
     console.warn("[NARA IIIF] 'sizes' array not found or invalid in info.json:", imageInfo);
     // Fallback to constructing a URL with a fixed width if sizes are missing
      const region = `0,0,${originalWidth},${originalHeight}`;
      const sizeParam = `!250,250`; // Max width 250, max height 250, maintain aspect ratio
      const rotation = "0";
      const quality = "default";
      const format = "jpg";
      return `https://catalog.archives.gov/iiif/3/${encodedIiifIdentifier}/${region}/${sizeParam}/${rotation}/${quality}.${format}`;
 }

 let selectedSize;
 // Try to get a size around 200-400px for preview.
 // NARA sizes are often [ { width: W1, height: H1 }, { width: W2, height: H2 }, ... ]
 // Let's aim for a "medium" size, or the largest available if few options.
 // Example: NARA sizes are often ordered smallest to largest.
 // We'll try to pick one that's not too small, not too large.
 // A simple heuristic: pick the one closest to 250px width, or a middle one.
 const targetPreviewWidth = 250;
 if (imageInfo.sizes.length > 0) {
     selectedSize = imageInfo.sizes.reduce((prev, curr) => {
         return (Math.abs(curr.width - targetPreviewWidth) < Math.abs(prev.width - targetPreviewWidth) ? curr : prev);
     });
     // If the chosen size is very small (e.g. < 100px) and there's a larger one, prefer a larger one.
     if (selectedSize.width < 100 && imageInfo.sizes.length > 1) {
          const largerSizes = imageInfo.sizes.filter(s => s.width > selectedSize.width);
          if (largerSizes.length > 0) {
             selectedSize = largerSizes[0]; // Take the next larger one
          }
     }
 } else {
     console.warn("[NARA IIIF] No sizes available in info.json.");
     return null;
 }


 if (!selectedSize || typeof selectedSize.width !== 'number' || typeof selectedSize.height !== 'number') {
     console.warn("[NARA IIIF] Selected thumbnail size is invalid:", selectedSize);
      // Fallback if selectedSize is bad
      const region = `0,0,${originalWidth},${originalHeight}`;
      const sizeParam = `!250,250`;
      const rotation = "0";
      const quality = "default";
      const format = "jpg";
      return `https://catalog.archives.gov/iiif/3/${encodedIiifIdentifier}/${region}/${sizeParam}/${rotation}/${quality}.${format}`;
 }

 const thumbWidth = selectedSize.width;
 const thumbHeight = selectedSize.height;

 const region = `0,0,${originalWidth},${originalHeight}`; // Full region
 const sizeParam = `${thumbWidth},${thumbHeight}`; // Request specific size from IIIF server
 const rotation = "0";
 const quality = "default";
 const format = "jpg";

 const previewImageUrl = `https://catalog.archives.gov/iiif/3/${encodedIiifIdentifier}/${region}/${sizeParam}/${rotation}/${quality}.${format}`;
 return previewImageUrl;

} catch (error) {
console.error("[NARA IIIF] Error in getNaraIiifPreviewUrl:", error);
return null;
}
}

// --- Popup Content ---
function createBundesarchivPopupContent(properties) {
let content = `Provenance: Bundesarchiv<br>`;
if (properties.case_name) content += `<b>${properties.case_name}</b><br>`;
if (properties.date) content += `Date: ${properties.date}<br>`; else content+= `Date: Unknown<br>`;
if (properties.archival_reference) content += `Archival Reference: ${properties.archival_reference}<br>`;
if (properties.direct_link) {
content += `<a href="${properties.direct_link}" target="_blank" rel="noopener noreferrer">View on Bundesarchiv Site</a><br>`;
}
return content || "No details available.";
}

function createNaraPopupContent(properties) {
let content = `Provenance: NARA<br>`;
if (properties.name) content += `${properties.name}<br>`;
if (properties.hasOwnProperty("origin")) {
let originText = "Unknown";
if (properties["origin"] === 1) originText = "German";
else if (properties["origin"] === 2) originText = "Allied";
content += `Collection Origin: ${originText}<br>`;
}
if (properties.date) content += `Date: ${properties.date}<br>`; else content+= `Date: Unknown<br>`;
if (properties.scale) content += `Scale: 1:${properties.scale}<br>`;
if (properties.naId) content += `NARA ID: <a href="https://catalog.archives.gov/id/${properties.naId}" target="_blank" rel="noopener noreferrer">${properties.naId}</a><br>`;

if (properties.objectUrl) {
    content += `<a href="${properties.objectUrl}" target="_blank" rel="noopener noreferrer">View Full Image</a><br>`;
    
    const { imageId, statusId } = getNaraPreviewElementIds(properties); // Uses deterministic IDs
    content += `<div id="${statusId}" class="nara-preview-status">Loading preview...</div>`;
    content += `<img id="${imageId}" src="#" alt="NARA Preview" class="popup-image nara-iiif-preview" style="display:none; max-width:250px; max-height:250px;">`;
}
return content || "No details available.";
}

function getGeoTiffElementIds(properties) {
// Ensure properties and image_id exist and image_id is suitable for an ID
if (!properties || typeof properties.image_id === 'undefined' || properties.image_id === null) {
const randomSuffix = Math.random().toString(36).substring(2, 9);
console.warn("[GeoTIFF] Missing image_id in properties, using random ID for preview elements:", properties);
return {
canvasId: `geotiff-canvas-random-${randomSuffix}`,
statusId: `geotiff-status-random-${randomSuffix}`
};
}
// Sanitize image_id: convert to string, remove characters invalid for DOM IDs
const sanitizedImageId = String(properties.image_id).replace(/[^a-zA-Z0-9_-]/g, '');
// Add a small random suffix to further help ensure ID uniqueness in complex DOM scenarios
const randomSuffix = Math.random().toString(36).substring(2, 5);
return {
canvasId: `geotiff-canvas-${sanitizedImageId}-${randomSuffix}`,
statusId: `geotiff-status-${sanitizedImageId}-${randomSuffix}`
};
}

function createIgnPopupContent(properties) {
let content = `Provenance: IGN<br>`;
if (properties.mission_id) content += `Mission ID: ${properties.mission_id}<br>`;
if (properties.image_no) content += `Image No: ${properties.image_no}<br>`;
if (properties.date) content += `Date: ${properties.date}<br>`; else content+= `Date: Unknown<br>`;
if (properties.hasOwnProperty('orientation')) { // Good practice to check
const normalizedOrientation = normalizeDegrees(properties.orientation);
if (!isNaN(normalizedOrientation)) { // Check if normalization result is a number
content += `Orientation: ${normalizedOrientation.toFixed(0)}°<br>`;
} else {
content += `Orientation: Invalid Data<br>`;
}
}

if (properties.scale) content += `Scale: 1:${properties.scale}<br>`;

const hasGeoTiffInfo = properties.mission_id && typeof properties.image_id !== 'undefined' && properties.image_id !== null;

if (hasGeoTiffInfo) {
    const geoTiffUrl = `https://data.geopf.fr/chunk/telechargement/download/pva/${properties.mission_id}/${properties.image_id}.tif`;
    const { canvasId, statusId } = getGeoTiffElementIds(properties);

    content += `<a href="${geoTiffUrl}" target="_blank" rel="noopener noreferrer">View Full GeoTIFF</a><br>`;
    content += `<div id="${statusId}" class="geotiff-preview-status">Loading preview...</div>`;
    content += `<canvas id="${canvasId}" class="popup-geotiff-canvas" style="display:none;"></canvas>`; // Initially hidden
    
} else if (properties.objectUrl) { // Fallback if no GeoTIFF info but an objectUrl exists
    content += `<a href="${properties.objectUrl}" target="_blank" rel="noopener noreferrer">View Full Image</a><br>`;
    if (/\.(jpeg|jpg|gif|png)$/i.test(properties.objectUrl)) {
         content += `<img src="${properties.objectUrl}" alt="Preview Image" class="popup-image">`;
    }
}
return content || "No details available.";
}

// NEW FUNCTION for WUR popup content
function createWurPopupContent(properties) {
    let content = `Provenance: WUR, RAF collection<br>`;
    content += `Metadata: `;
    if (properties.flight) content += `Flight ${properties.flight}, `;
    if (properties.run) content += `Run ${properties.run}, `;
    if (properties.aerialphoto) content += `Photo ${properties.aerialphoto}, `;
    if (properties.sortie) content += `Sortie ${properties.sortie}`;
    content = content.trim().endsWith(',') ? content.slice(0, -1) : content; // Remove trailing comma if any
    content += `<br>`;

    if (properties.date) content += `Date: ${properties.date}<br>`; else content+= `Date: Unknown<br>`;
    if (properties.scale) content += `Scale: 1:${properties.scale}<br>`;

    if (properties.cachedImageUrl) {
        content += `<a href="${properties.cachedImageUrl}" target="_blank" rel="noopener noreferrer">View Full Image</a><br>`;
        content += `<img src="${properties.cachedImageUrl}" alt="WUR Preview" class="popup-image" style="max-width:250px; max-height:250px;">`;
    }
    return content || "No details available.";
}


function createPopupContent(properties) {
// Dispatch to specific popup creators based on unique properties
// Order matters: more specific checks should come first.
if(properties["provenance"] == "nara") { // NARA
return createNaraPopupContent(properties);
} else if (properties["provenance"] == "barch") { // Bundesarchiv
return createBundesarchivPopupContent(properties);
} else if (properties["provenance"] == "ign") { // IGN
return createIgnPopupContent(properties);
} else if (properties["provenance"] == "wur") { // WUR (NEW)
return createWurPopupContent(properties);
}
// Generic fallback if no specific type is identified
let genericContent = '<b>Details:</b><br>';
for (const key in properties) {
// Check if the property belongs to the object itself (not inherited)
if (Object.prototype.hasOwnProperty.call(properties, key)) {
genericContent += `${key}: ${properties[key]}<br>`;
}
}
return genericContent || "No details available.";
}

async function handleNaraPopupOpen(event) {
const layer = event.target;
const feature = layer.feature;

if (!feature || !feature.properties || !feature.properties.objectUrl) return;
const properties = feature.properties;

const popupContentElement = event.popup.getElement().querySelector('.leaflet-popup-content');
if (!popupContentElement) {
    console.error("[NARA IIIF POPUP] Could not find popup content element.");
    return;
}

const { imageId, statusId } = getNaraPreviewElementIds(properties);
const imageElement = popupContentElement.querySelector(`#${imageId}`);
const statusElement = popupContentElement.querySelector(`#${statusId}`);

if (!imageElement || !statusElement) {
    console.error(`[NARA IIIF POPUP] Could not find image or status element for NARA ID: ${properties.naId}. Expected IDs: image='${imageId}', status='${statusId}'`);
    if (statusElement) statusElement.textContent = "Error: Preview elements missing in popup.";
    return;
}

// If image is already loaded and displayed, and status is hidden, do nothing.
if (imageElement.src && imageElement.src !== '#' && !imageElement.src.endsWith('/#') && imageElement.style.display === 'block') {
    if (statusElement && statusElement.style.display !== 'none') { // If status somehow still visible, hide it.
         statusElement.remove();
    }
    return;
}

statusElement.textContent = 'Fetching preview...'; // Explicitly set loading message
statusElement.style.display = 'block'; // Ensure status is visible
imageElement.style.display = 'none'; // Hide image element until loaded

try {
    const previewUrl = await getNaraIiifPreviewUrl(properties.objectUrl);
    if (previewUrl) {
        imageElement.onload = () => {
            imageElement.style.display = 'block';
            if (statusElement) statusElement.remove(); // Remove status on success
        };
        imageElement.onerror = () => {
            console.error("[NARA IIIF POPUP] Failed to load image from URL:", previewUrl);
            if (statusElement) {
                statusElement.textContent = 'Error loading image.';
                statusElement.style.display = 'block'; // Keep status visible on error
            }
            imageElement.style.display = 'none';
        };
        imageElement.src = previewUrl;
    } else {
        if (statusElement) statusElement.textContent = 'Preview not available.';
        imageElement.style.display = 'none';
    }
} catch (error) {
    console.error("[NARA IIIF POPUP] Error handling NARA popup open:", error);
    if (statusElement) statusElement.textContent = 'Error generating preview.';
    imageElement.style.display = 'none';
}
}

async function handleIgnPopupOpen(event) {
const layer = event.target;
const feature = layer.feature;

if (!feature || !feature.properties) return;
const properties = feature.properties;

// Only proceed if GeoTIFF info is present (mission_id and image_id)
if (properties.mission_id && typeof properties.image_id !== 'undefined' && properties.image_id !== null) {
    const popupContentElement = event.popup.getElement().querySelector('.leaflet-popup-content');
    if (!popupContentElement) {
        console.error("[IGN POPUP] Could not find popup content element.");
        return;
    }

    // Find canvas and status elements using their classes, then get their IDs
    // This is more robust than assuming IDs if they are dynamically generated
    const canvasElement = popupContentElement.querySelector('.popup-geotiff-canvas');
    const statusElement = popupContentElement.querySelector('.geotiff-preview-status');

    if (!canvasElement || !statusElement) {
        console.error("[IGN POPUP] Could not find canvas or status element for feature:", properties.image_id);
        // If statusElement is somehow found but canvas isn't (or vice versa), update status.
        if (statusElement) statusElement.textContent = "Error: Preview elements missing.";
        return;
    }
    
    const canvasId = canvasElement.id;
    const statusId = statusElement.id;

    if (!canvasId) {
        console.error("[IGN POPUP] Canvas element in popup is missing an ID for feature:", properties.image_id);
        statusElement.textContent = "Error: Canvas ID missing."; // Update status if ID is missing
        return;
    }
     // Check if canvas is already rendered and visible (and status is hidden)
    if (canvasElement.style.display === 'block' && canvasElement.width > 0 && statusElement.style.display === 'none') {
        return; // Already loaded
    }


    const geoTiffUrl = `https://data.geopf.fr/chunk/telechargement/download/pva/${properties.mission_id}/${properties.image_id}.tif`;
    const imageFilename = `${properties.image_id}.tif`; // For logging

    _internal_loadAndRenderGeoTiffPreview(geoTiffUrl, canvasId, statusId, imageFilename);
}
}

function createGeoJsonLayer(geoJsonFeatureCollection) {
return L.geoJSON(geoJsonFeatureCollection, {
onEachFeature: function (feature, layer) {
if (feature.properties) {
layer.bindPopup(createPopupContent(feature.properties), {
maxWidth: 350,
minWidth: 250,
// Keep popups open when others are opened, useful for comparing
// autoClose: false,
// closeOnClick: true // Default behavior, popup closes if map is clicked
});

// Attach specific popupopen handlers based on properties
            if (feature.properties.naId && feature.properties.objectUrl) {
                layer.on('popupopen', handleNaraPopupOpen);
            }
            // For IGN, the check for mission_id and image_id ensures GeoTIFF capability
            if (feature.properties.mission_id && typeof feature.properties.image_id !== 'undefined' && feature.properties.image_id !== null) {
                layer.on('popupopen', handleIgnPopupOpen);
            }
            // No specific 'popupopen' handler needed for Bundesarchiv or WUR yet,
            // unless they involve async preview loading in the future.
        }
    }
});
}

function createSharedMarkerClusterGroup() {
function sharedChunkProgressCallback(processed, total) {
if (processed < total) {
updateLoaderText(chunkProgressTextGenerator(processed, total));
} else {
updateLoaderText(chunkFinalizeTextGenerator());
hideLoader(); // Hide loader once all chunks are processed
}
}
return L.markerClusterGroup({
chunkedLoading: true,
maxClusterRadius: 70, // Default is 80, adjust as needed
chunkProgress: sharedChunkProgressCallback
// Other options:
// spiderfyOnMaxZoom: true,
// showCoverageOnHover: true,
// zoomToBoundsOnClick: true,
});
}

function initializeDateSliders() {
sliderMinEpoch = getEpochFromDateString(SLIDER_MIN_DATE_STR, 'start');
sliderMaxEpoch = getEpochFromDateString(SLIDER_MAX_DATE_STR, 'start'); // Use 'start' for consistent slider step values

if (isNaN(sliderMinEpoch) || isNaN(sliderMaxEpoch)) {
    console.error("Invalid SLIDER_MIN_DATE_STR or SLIDER_MAX_DATE_STR. Disabling date filter.");
    if(domElements.dateFilterControls) domElements.dateFilterControls.classList.add('hidden');
    return;
}

domElements.startDateSlider.min = sliderMinEpoch;
domElements.startDateSlider.max = sliderMaxEpoch;
domElements.startDateSlider.value = sliderMinEpoch;
domElements.endDateSlider.min = sliderMinEpoch;
domElements.endDateSlider.max = sliderMaxEpoch;
domElements.endDateSlider.value = sliderMaxEpoch;

currentStartDateEpoch = sliderMinEpoch;
currentEndDateEpoch = sliderMaxEpoch;

domElements.startDateValueDisplay.textContent = formatDateEpochToInput(currentStartDateEpoch);
domElements.endDateValueDisplay.textContent = formatDateEpochToInput(currentEndDateEpoch);

domElements.startDateSlider.addEventListener('input', handleDateSliderChange);
domElements.endDateSlider.addEventListener('input', handleDateSliderChange);

if(domElements.dateFilterControls) domElements.dateFilterControls.classList.remove('hidden');
}

function handleDateSliderChange(event) {
let newStartEpoch = parseInt(domElements.startDateSlider.value, 10);
let newEndEpoch = parseInt(domElements.endDateSlider.value, 10);

// Ensure start date is not after end date
if (event.target.id === 'startDateSlider' && newStartEpoch > newEndEpoch) {
    newEndEpoch = newStartEpoch;
    domElements.endDateSlider.value = newEndEpoch;
} else if (event.target.id === 'endDateSlider' && newEndEpoch < newStartEpoch) {
    newStartEpoch = newEndEpoch;
    domElements.startDateSlider.value = newStartEpoch;
}

currentStartDateEpoch = newStartEpoch;
currentEndDateEpoch = newEndEpoch;

domElements.startDateValueDisplay.textContent = formatDateEpochToInput(currentStartDateEpoch);
domElements.endDateValueDisplay.textContent = formatDateEpochToInput(currentEndDateEpoch);

clearTimeout(debounceTimer);
debounceTimer = setTimeout(filterAndRedrawMapWithWorker, DEBOUNCE_DELAY);
}

function filterAndRedrawMapWithWorker() {
if (!fullGeoJsonData || !fullGeoJsonData.features || !map) {
console.warn("Data or map not ready for filtering.");
if(fullGeoJsonData && fullGeoJsonData.features && fullGeoJsonData.features.length === 0){
updateLoaderText('No features to filter.');
hideLoader();
}
return;
}

showLoader(true, false, `Filtering for ${formatDateEpochToInput(currentStartDateEpoch)} to ${formatDateEpochToInput(currentEndDateEpoch)}...`);

if (activeFilterWorker) {
    console.log("[Filter] Terminating existing filter worker.");
    activeFilterWorker.terminate();
    activeFilterWorker = null; // Ensure it's nullified after termination
}

activeFilterWorker = new Worker(FILTER_WORKER_PATH);

// For filtering, we need the full day range for start and end dates
const startFilterEpoch = getEpochFromDateString(formatDateEpochToInput(currentStartDateEpoch), 'start');
const endFilterEpoch = getEpochFromDateString(formatDateEpochToInput(currentEndDateEpoch), 'end');

activeFilterWorker.onmessage = (e) => {
    if (e.data.type === 'success') {
        const filteredGeoJson = { type: "FeatureCollection", features: e.data.data };
        updateMapWithFilteredData(filteredGeoJson);
    } else {
        console.error("Filter worker error:", e.data.message, e.data);
        updateLoaderText(`Error during filtering: ${e.data.message}`);
        hideLoader(0); // Hide immediately on error
    }
    if (activeFilterWorker) { // Check if it wasn't terminated by an error
        activeFilterWorker.terminate();
        activeFilterWorker = null;
    }
};

activeFilterWorker.onerror = (err) => {
    console.error("Filter worker script error:", err.message, err);
    updateLoaderText(`Critical filter worker error: ${err.message}`);
    hideLoader(0);
    if (activeFilterWorker) {
        activeFilterWorker.terminate();
        activeFilterWorker = null;
    }
};

activeFilterWorker.postMessage({
    features: fullGeoJsonData.features,
    datePropertyName: DATE_PROPERTY_NAME,
    startFilterEpoch: startFilterEpoch,
    endFilterEpoch: endFilterEpoch
});
}

function updateMapWithFilteredData(filteredGeoJson) {
if (!markerClusterGroup) {
console.error("markerClusterGroup not initialized for update.");
hideLoader(0);
return;
}
markerClusterGroup.clearLayers();
const featureCount = filteredGeoJson.features ? filteredGeoJson.features.length : 0;

if (featureCount > 0) {
    const originalChunkProgressTextGenerator = chunkProgressTextGenerator;
    const originalChunkFinalizeTextGenerator = chunkFinalizeTextGenerator;

    // Update loader text for filtering specifically
    chunkProgressTextGenerator = (p, t) => `Updating map with filtered features: ${Math.round((p/t)*100)}% (${p}/${t})`;
    chunkFinalizeTextGenerator = () => `Finalizing filtered map...`;

    // No need to show a separate loader if chunkedLoading's progress is used
    // showLoader(true, false, `Processing ${featureCount} filtered features...`);
    if (featureCount <= LARGE_DATASET_THRESHOLD) {
         // For smaller datasets, chunked loading might finish too fast for progress text to be meaningful
         // So, set a general "applying filter" message.
         updateLoaderText(`Applying filter (${featureCount} features)...`);
    }


    const geoJsonLayer = createGeoJsonLayer(filteredGeoJson);
    markerClusterGroup.addLayer(geoJsonLayer); // This will trigger chunkProgress

    // Restore original generators if they are used elsewhere (e.g. initial load)
    chunkProgressTextGenerator = originalChunkProgressTextGenerator;
    chunkFinalizeTextGenerator = originalChunkFinalizeTextGenerator;

    // No explicit hideLoader() here, as chunkProgress callback in createSharedMarkerClusterGroup will handle it.
} else {
    updateLoaderText('No features match the current filter. Displaying 0 features.');
    hideLoader(); // Hide loader if no features
}
}

function displayInitialData(geojsonData) {
fullGeoJsonData = geojsonData; // Store the full dataset
const totalFeatures = geojsonData.features ? geojsonData.features.length : 0;

if (!markerClusterGroup) {
    markerClusterGroup = createSharedMarkerClusterGroup();
    map.addLayer(markerClusterGroup);
} else {
    markerClusterGroup.clearLayers(); // Clear if it was somehow pre-existing
}

if (totalFeatures > 0) {
    const originalChunkProgressTextGenerator = chunkProgressTextGenerator;
    const originalChunkFinalizeTextGenerator = chunkFinalizeTextGenerator;

    // Set specific loader text for initial load
    chunkProgressTextGenerator = (p, t) => `Adding initial features: ${Math.round((p/t)*100)}% (${p}/${t})`;
    chunkFinalizeTextGenerator = () => `Finalizing initial map display...`;
    
    // Show a general loading message before chunked loading starts
    if (totalFeatures > LARGE_DATASET_THRESHOLD) {
        showLoader(true, false, 'Adding initial features (large dataset processing)...');
    } else {
        // For smaller datasets, show a simpler message or let chunkedLoading handle it.
        // updateLoaderText('Processing initial features...');
        // showLoader may not be needed if chunked loading starts immediately and updates text.
    }

    const geoJsonLayer = createGeoJsonLayer(geojsonData);
    markerClusterGroup.addLayer(geoJsonLayer); // This will trigger chunkProgress

    const bounds = geoJsonLayer.getBounds();
    if (bounds.isValid()) {
        map.fitBounds(bounds.pad(0.1)); // Add slight padding
    } else {
        console.warn("Could not determine valid bounds for initial data, using default view.");
        map.setView(DEFAULT_EMPTY_MAP_VIEW, DEFAULT_EMPTY_MAP_ZOOM);
    }
    
    // Restore original generators
    chunkProgressTextGenerator = originalChunkProgressTextGenerator;
    chunkFinalizeTextGenerator = originalChunkFinalizeTextGenerator;
    // hideLoader() will be called by the chunkProgress callback
} else {
    updateLoaderText('No initial features to display. Map is empty.');
    map.setView(DEFAULT_EMPTY_MAP_VIEW, DEFAULT_EMPTY_MAP_ZOOM);
    hideLoader();
}
initializeDateSliders(); // Initialize sliders after data is ready (or if no data)
}

async function loadAndDisplayData() {
showLoader(true, false, 'Initializing application...');
let mapInitializedDuringLoading = false;

// Initialize map structure early, even if data loading takes time
if (!map && domElements.mapElement) {
    updateLoaderText('Initializing map framework...');
    map = L.map(domElements.mapElement); // Initialize map
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19
    }).addTo(map);
    mapInitializedDuringLoading = true;
}


try {
    showLoader(true, false, 'Downloading geospatial data...');
    const fetchPromises = GEOJSON_FILE_PATHS.map(async (path) => {
        try {
            const response = await fetch(path);
            if (!response.ok) {
                console.warn(`Could not fetch ${path}: ${response.status} ${response.statusText}. Skipping this file.`);
                return null; // Return null for failed fetches
            }
            const textData = await response.text();
             if (textData.trim() === "") {
                console.warn(`Fetched ${path} but it was empty. Skipping this file.`);
                return null; // Return null for empty files
            }
            return textData;
        } catch (error) {
            console.warn(`Error fetching ${path}:`, error, ". Skipping this file.");
            return null; // Return null on network or other fetch errors
        }
    });
    const geoJsonStrings = await Promise.all(fetchPromises);
    const validGeoJsonStrings = geoJsonStrings.filter(s => typeof s === 'string' && s.trim() !== ''); // Filter out nulls

    if (validGeoJsonStrings.length === 0) {
         const errorMsg = "Could not fetch any valid, non-empty GeoJSON data from sources. Map will be empty.";
         console.error("[MAP_LOGIC] " + errorMsg);
         updateLoaderText(errorMsg);
         displayInitialData({ type: "FeatureCollection", features: [] }); // Display empty map, init sliders
         // No need to throw, just proceed with an empty map.
         // hideLoader() will be called by displayInitialData.
         return; // Stop further processing if no data
    }

    showLoader(true, false, 'Parsing geospatial data...');
    const parserWorker = new Worker(PARSE_WORKER_PATH);

    parserWorker.onmessage = (e) => {
        if (e.data.type === 'success') {
            let geojsonData = e.data.data;
            if (!geojsonData || !geojsonData.features) {
                console.warn("Parsed GeoJSON is invalid or has no features. Using empty dataset.");
                geojsonData = { type: "FeatureCollection", features: [] };
            }
            // If map wasn't initialized before, ensure it is now
            if (!map && domElements.mapElement) {
                updateLoaderText('Initializing map framework...');
                map = L.map(domElements.mapElement);
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
                    maxZoom: 19
                }).addTo(map);
            } else if (!map) {
                 console.error("Map element not found, cannot initialize map after parsing.");
                 updateLoaderText("Error: Map element missing.");
                 hideLoader(0);
                 parserWorker.terminate();
                 return;
            }
            displayInitialData(geojsonData); // This will handle loader hiding via chunkProgress
        } else {
            console.error("[MAP_LOGIC] Parser worker error message received:", e.data.message, e.data);
            updateLoaderText(`Parsing failed: ${e.data.message}. Displaying empty map.`);
            displayInitialData({ type: "FeatureCollection", features: [] }); // Show empty map on parse error
            // hideLoader() will be called by displayInitialData
        }
        parserWorker.terminate();
    };

    parserWorker.onerror = (err) => {
        console.error("[MAP_LOGIC] Parser worker script error:", err.message, err);
        updateLoaderText(`Critical parser worker error: ${err.message}. Displaying empty map.`);
        displayInitialData({ type: "FeatureCollection", features: [] }); // Show empty map on critical worker error
        // hideLoader() will be called by displayInitialData
        if (parserWorker) parserWorker.terminate();
    };
    
    parserWorker.postMessage({
        geoJsonStrings: validGeoJsonStrings,
        datePropertyName: DATE_PROPERTY_NAME
    });

    // If map wasn't initialized earlier and parsing is slow, this provides quicker visual feedback.
    if (!mapInitializedDuringLoading && !map && domElements.mapElement) {
         updateLoaderText('Initializing map framework (concurrently with parsing)...');
         map = L.map(domElements.mapElement);
         L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
             attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
             maxZoom: 19
         }).addTo(map);
    }

} catch (error) { // Catch errors from the try block (e.g., if Promise.all itself fails unexpectedly)
    console.error("[MAP_LOGIC] Failed to load or display GeoJSON (main catch block):", error);
    updateLoaderText(`Error: ${error.message}. Check console. Displaying empty map.`);
    if (!map && domElements.mapElement) { // Ensure map is initialized for a fallback view
         map = L.map(domElements.mapElement).setView(DEFAULT_EMPTY_MAP_VIEW, DEFAULT_EMPTY_MAP_ZOOM);
         L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OSM contributors'}).addTo(map);
    }
    displayInitialData({ type: "FeatureCollection", features: [] }); // Show empty map and init sliders
    // hideLoader() will be called by displayInitialData
}
}

document.addEventListener('DOMContentLoaded', () => {
domElements = {
loaderContainer: document.getElementById('loader-container'),
spinner: document.querySelector('#loader-container .spinner'),
progressInfo: document.getElementById('progress-info'),
progressBarContainer: document.getElementById('progress-bar-container'),
loaderText: document.getElementById('loader-text'),
dateFilterControls: document.getElementById('date-filter-controls'),
startDateSlider: document.getElementById('startDateSlider'),
endDateSlider: document.getElementById('endDateSlider'),
startDateValueDisplay: document.getElementById('startDateValue'),
endDateValueDisplay: document.getElementById('endDateValue'),
mapElement: document.getElementById('map')
};

// Initially hide progress bar elements as they are used by specific loaders
if (domElements.progressInfo) domElements.progressInfo.classList.add('hidden');
if (domElements.progressBarContainer) domElements.progressBarContainer.classList.add('hidden');

const missingElements = Object.entries(domElements).filter(([, el]) => !el);
if (missingElements.length > 0) {
    const missingElementIds = missingElements.map(([key]) => key + (domElements[key] === undefined ? " (id not found)" : "")).join(', ');
    const errorMsg = `Critical HTML element(s) missing: ${missingElementIds}. App cannot fully start.`;
    console.error(errorMsg);
    if(domElements.loaderContainer && domElements.loaderText) { // If loader exists, use it to display error
        updateLoaderText(errorMsg);
        if(domElements.spinner) domElements.spinner.classList.add('hidden'); // Hide spinner on critical error
    } else { // Fallback if even loader is broken
        alert(errorMsg);
    }
    return; // Stop execution
}
loadAndDisplayData();
});