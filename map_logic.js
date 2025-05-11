// --- Constants ---
const GEOJSON_FILE_PATH = 'scans.geojson';
const PARSE_WORKER_PATH = 'parse_worker.js';
const FILTER_WORKER_PATH = 'filter_worker.js';
const DATE_PROPERTY_NAME = 'date';
const ORIGIN_PROPERTY_NAME = 'origin';
const DEBOUNCE_DELAY = 300;
const SLIDER_MIN_DATE_STR = '1940-01-01';
const SLIDER_MAX_DATE_STR = '1945-12-31';
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

// --- UI Update Functions ---
function updateLoaderText(message) {
    if (domElements.loaderText) domElements.loaderText.textContent = message;
}

function showLoader(showSpinner = true, showProgressBar = false, text = "Loading...") {
    if (!domElements.loaderContainer) return;
    updateLoaderText(text);
    domElements.loaderContainer.classList.remove('hidden');
    if (domElements.spinner) domElements.spinner.classList.toggle('hidden', !showSpinner);
    // Ensure progress bar elements are hidden if showProgressBar is false
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

// updateProgressBar is no longer used for download, but Leaflet MarkerCluster might have its own progress concept
// For now, this function is not directly called by the simplified download.
// If you re-introduce a progress bar for other operations, it's here.
/*
function updateProgressBar(percentage) {
    if (domElements.progressBar) domElements.progressBar.style.width = `${percentage}%`;
}
*/

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

// --- Popup Content ---
function createPopupContent(properties) {
    let content = ``;
    if (properties.name) content += `<b>${properties.name}</b><br>`;
    if (properties.hasOwnProperty(ORIGIN_PROPERTY_NAME)) {
        let originText = "Unknown";
        if (properties[ORIGIN_PROPERTY_NAME] === 1) originText = "German";
        else if (properties[ORIGIN_PROPERTY_NAME] === 2) originText = "Allied";
        content += `Origin: ${originText}<br>`;
    }
    if (properties.date) content += `Date: ${properties.date}<br>`;
    if (properties.scale) content += `Scale: ${properties.scale}<br>`;
    if (properties.naId) content += `NARA ID: <a href="https://catalog.archives.gov/id/${properties.naId}" target="_blank" rel="noopener noreferrer">${properties.naId}</a><br>`;
    if (properties.objectUrl) {
        content += `<a href="${properties.objectUrl}" target="_blank" rel="noopener noreferrer">View Full Image</a><br>`;
        if (/\.(jpeg|jpg|gif|png)$/i.test(properties.objectUrl)) {
             content += `<img src="${properties.objectUrl}" alt="Preview Image" class="popup-image">`;
        }
    }
    return content || "No details available.";
}

// --- Map Layer Handling ---
function createGeoJsonLayer(geoJsonFeatureCollection) {
    return L.geoJSON(geoJsonFeatureCollection, {
        onEachFeature: function (feature, layer) {
            if (feature.properties) {
                layer.bindPopup(createPopupContent(feature.properties), { maxWidth: 300 });
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
            hideLoader();
        }
    }
    return L.markerClusterGroup({
        chunkedLoading: true,
        maxClusterRadius: 70,
        chunkProgress: sharedChunkProgressCallback
    });
}

// --- Date Filter Logic ---
function initializeDateSliders() {
    sliderMinEpoch = getEpochFromDateString(SLIDER_MIN_DATE_STR, 'start');
    sliderMaxEpoch = getEpochFromDateString(SLIDER_MAX_DATE_STR, 'start');

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
        return;
    }

    showLoader(true, false, `Filtering for ${formatDateEpochToInput(currentStartDateEpoch)} to ${formatDateEpochToInput(currentEndDateEpoch)}...`);

    if (activeFilterWorker) {
        activeFilterWorker.terminate();
        console.log("Previous filter worker terminated.");
    }

    activeFilterWorker = new Worker(FILTER_WORKER_PATH);

    const startFilterEpoch = getEpochFromDateString(formatDateEpochToInput(currentStartDateEpoch), 'start');
    const endFilterEpoch = getEpochFromDateString(formatDateEpochToInput(currentEndDateEpoch), 'end');

    activeFilterWorker.onmessage = (e) => {
        if (e.data.type === 'success') {
            const filteredGeoJson = { type: "FeatureCollection", features: e.data.data };
            updateMapWithFilteredData(filteredGeoJson);
        } else {
            console.error("Filter worker error:", e.data.message);
            updateLoaderText(`Error during filtering: ${e.data.message}`);
            hideLoader(0);
        }
        activeFilterWorker.terminate();
        activeFilterWorker = null;
    };

    activeFilterWorker.onerror = (err) => {
        console.error("Filter worker script error:", err.message, err);
        updateLoaderText(`Critical filter worker error: ${err.message}`);
        hideLoader(0);
        if (activeFilterWorker) activeFilterWorker.terminate(); // Ensure termination
        activeFilterWorker = null;
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
    const featureCount = filteredGeoJson.features.length;

    if (featureCount > 0) {
        chunkProgressTextGenerator = (p, t) => `Updating map: ${Math.round((p/t)*100)}% (${p}/${t} features)`;
        chunkFinalizeTextGenerator = () => `Finalizing filtered map...`;

        if (featureCount > LARGE_DATASET_THRESHOLD) {
            updateLoaderText('Applying filter, adding features to map...');
        } else {
            updateLoaderText(`Processing ${featureCount} filtered features...`);
        }

        const geoJsonLayer = createGeoJsonLayer(filteredGeoJson);
        markerClusterGroup.addLayer(geoJsonLayer);

        if (featureCount <= LARGE_DATASET_THRESHOLD) {
            updateLoaderText(`Displaying ${featureCount} filtered features.`);
            hideLoader();
        }
    } else {
        updateLoaderText('No features match filter. Displaying 0 features.');
        hideLoader();
    }
}

function displayInitialData(geojsonData) {
    fullGeoJsonData = geojsonData;
    const totalFeatures = geojsonData.features ? geojsonData.features.length : 0;

    if (!markerClusterGroup) {
        markerClusterGroup = createSharedMarkerClusterGroup();
        map.addLayer(markerClusterGroup);
    } else {
        markerClusterGroup.clearLayers();
    }

    if (totalFeatures > 0) {
        chunkProgressTextGenerator = (p, t) => `Adding initial features: ${Math.round((p/t)*100)}% (${p}/${t})`;
        chunkFinalizeTextGenerator = () => `Finalizing initial features...`;

        if (totalFeatures > LARGE_DATASET_THRESHOLD) {
            showLoader(true, false, 'Adding initial features (large dataset processing)...');
        } else {
            updateLoaderText('Processing initial features...');
        }

        const geoJsonLayer = createGeoJsonLayer(geojsonData);
        markerClusterGroup.addLayer(geoJsonLayer);

        const bounds = geoJsonLayer.getBounds();
        if (bounds.isValid()) {
            map.fitBounds(bounds.pad(0.1));
        } else {
            console.warn("Could not determine valid bounds, using default view.");
            map.setView(DEFAULT_EMPTY_MAP_VIEW, DEFAULT_EMPTY_MAP_ZOOM);
        }

        if (totalFeatures <= LARGE_DATASET_THRESHOLD) {
            updateLoaderText(`Displaying ${totalFeatures} features. Map ready.`);
            hideLoader();
        }
    } else {
        updateLoaderText('No initial features to display.');
        map.setView(DEFAULT_EMPTY_MAP_VIEW, DEFAULT_EMPTY_MAP_ZOOM);
        hideLoader();
    }
    initializeDateSliders();
}

async function loadAndDisplayData() {
    // Start with initializing app message, spinner only
    showLoader(true, false, 'Initializing application...');

    try {
        // Update to "Fetching..." message, spinner only
        showLoader(true, false, 'Downloading geospatial data...');
        const response = await fetch(GEOJSON_FILE_PATH);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status} fetching ${GEOJSON_FILE_PATH}`);

        // Get the response as text directly
        const geoJsonString = await response.text();

        // --- Parsing with Worker ---
        showLoader(true, false, 'Parsing downloaded data in background...');
        const parserWorker = new Worker(PARSE_WORKER_PATH);

        parserWorker.onmessage = (e) => {
            if (e.data.type === 'success') {
                let geojsonData = e.data.data;
                if (!geojsonData || !geojsonData.features) {
                    console.warn("Parsed GeoJSON is invalid or has no features. Using empty dataset.");
                    geojsonData = { type: "FeatureCollection", features: [] };
                }

                if (!map) {
                    updateLoaderText('Initializing map framework...');
                    map = L.map(domElements.mapElement);
                    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
                        maxZoom: 19
                    }).addTo(map);
                }
                displayInitialData(geojsonData);
            } else {
                console.error("Parser worker error:", e.data.message);
                throw new Error(`Parsing failed: ${e.data.message}`);
            }
            parserWorker.terminate();
        };

        parserWorker.onerror = (err) => {
            console.error("Parser worker script error:", err.message, err);
            if (parserWorker) parserWorker.terminate();
            throw new Error(`Critical parser worker error: ${err.message}`);
        };

        parserWorker.postMessage({ geoJsonString });

        if (!map) {
            updateLoaderText('Initializing map framework and parsing data...');
             map = L.map(domElements.mapElement);
             L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                 attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
                 maxZoom: 19
             }).addTo(map);
        }

    } catch (error) {
        console.error("Failed to load or display GeoJSON:", error);
        updateLoaderText(`Error: ${error.message}. Check console.`);
        if (!map && domElements.mapElement) {
             map = L.map(domElements.mapElement).setView(DEFAULT_EMPTY_MAP_VIEW, DEFAULT_EMPTY_MAP_ZOOM);
             L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OSM contributors'}).addTo(map);
        }
        hideLoader(0);
    }
    // The 'finally' block is removed as its role for loader management is diminished
    // with the current flow where errors or completion in workers/displayInitialData handle hiding.
    // If progress bar was used for other things, might need to reset it here.
}

document.addEventListener('DOMContentLoaded', () => {
    domElements = {
        loaderContainer: document.getElementById('loader-container'),
        spinner: document.querySelector('#loader-container .spinner'),
        progressInfo: document.getElementById('progress-info'), // Still needed to hide it
        progressBarContainer: document.getElementById('progress-bar-container'), // Still needed to hide it
        // progressBar: document.getElementById('progress-bar'), // Not directly manipulated now
        loaderText: document.getElementById('loader-text'),
        dateFilterControls: document.getElementById('date-filter-controls'),
        startDateSlider: document.getElementById('startDateSlider'),
        endDateSlider: document.getElementById('endDateSlider'),
        startDateValueDisplay: document.getElementById('startDateValue'),
        endDateValueDisplay: document.getElementById('endDateValue'),
        mapElement: document.getElementById('map')
    };

    // Ensure progress bar related elements are hidden initially by showLoader if not used
    if (domElements.progressInfo) domElements.progressInfo.classList.add('hidden');
    if (domElements.progressBarContainer) domElements.progressBarContainer.classList.add('hidden');


    const missingElements = Object.entries(domElements).filter(([, el]) => !el && el !== domElements.progressBar ); // progressBar is optional now
    if (missingElements.length > 0) {
        const missingElementIds = missingElements.map(([key]) => key).join(', ');
        console.error(`Critical HTML element(s) missing: ${missingElementIds}.`);
        if(domElements.loaderContainer) {
            updateLoaderText(`Error: UI elements missing (${missingElementIds}).`);
            if(domElements.spinner) domElements.spinner.classList.add('hidden');
        } else {
            alert(`Error: Critical UI elements missing (${missingElementIds}). App cannot start.`);
        }
        return;
    }
    loadAndDisplayData();
});