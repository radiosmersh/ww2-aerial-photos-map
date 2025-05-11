// --- Constants ---
const GEOJSON_FILE_PATH = 'scans.geojson';
const DATE_PROPERTY_NAME = 'date';
const ORIGIN_PROPERTY_NAME = 'origin';
const DEBOUNCE_DELAY = 300;
const SLIDER_MIN_DATE_STR = '1940-01-01';
const SLIDER_MAX_DATE_STR = '1945-12-31';
const LARGE_DATASET_THRESHOLD = 1000;
const DEFAULT_EMPTY_MAP_VIEW = [20, 0];
const DEFAULT_EMPTY_MAP_ZOOM = 2;
const LOADER_HIDE_DELAY = 100; // Standard delay for hiding loader after final text

// --- DOM Element References (initialized in DOMContentLoaded) ---
let domElements = {};

// --- Map & Layer Variables ---
let map;
let markerClusterGroup;
let fullGeoJsonData;

// --- Date Filter Variables ---
let currentStartDateEpoch, currentEndDateEpoch;
let debounceTimer;
let sliderMinEpoch, sliderMaxEpoch;

// --- Loader Text Generators (for chunk progress) ---
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
    if (domElements.progressInfo) domElements.progressInfo.classList.toggle('hidden', !showProgressBar);
}

function hideLoader(delay = LOADER_HIDE_DELAY) {
    if (!domElements.loaderContainer || domElements.loaderContainer.classList.contains('hidden')) return;
    setTimeout(() => {
        if (domElements.loaderContainer) {
            domElements.loaderContainer.classList.add('hidden');
        }
    }, delay);
}

function updateProgressBar(percentage) {
    if (domElements.progressBar) domElements.progressBar.style.width = `${percentage}%`;
}

// --- Date Helper Functions ---
function getEpochFromDateString(dateStr, atTime = 'start') {
    if (!dateStr) return NaN;
    let fullDateStr = dateStr;
    if (atTime === 'start') fullDateStr += 'T00:00:00.000Z';
    else if (atTime === 'end') fullDateStr += 'T23:59:59.999Z';
    else if (dateStr.length === 10) fullDateStr += 'T00:00:00Z'; // 'exact' for date-only strings defaults to start of day
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
function createGeoJsonLayer(geojsonData) {
    return L.geoJSON(geojsonData, {
        onEachFeature: function (feature, layer) {
            if (feature.properties) {
                layer.bindPopup(createPopupContent(feature.properties), { maxWidth: 300 });
            }
        }
    });
}

function createSharedMarkerClusterGroup() {
    function sharedChunkProgressCallback(processed, total) {
        // This callback is used by L.markercluster when chunkedLoading is true
        // and it processes data in chunks.
        if (processed < total) {
            updateLoaderText(chunkProgressTextGenerator(processed, total));
        } else {
            // All chunks processed
            updateLoaderText(chunkFinalizeTextGenerator());
            hideLoader(); // Uses default LOADER_HIDE_DELAY
        }
    }
    return L.markerClusterGroup({
        chunkedLoading: true, // Enable Leaflet.markercluster's chunked loading
        maxClusterRadius: 70,   // Example: Adjust as needed
        chunkProgress: sharedChunkProgressCallback // Provide the callback
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
    debounceTimer = setTimeout(filterAndRedrawMap, DEBOUNCE_DELAY);
}

function filterAndRedrawMap() {
    if (!fullGeoJsonData || !map) {
        console.warn("Data or map not ready for filtering.");
        return;
    }

    showLoader(true, false, `Filtering for ${formatDateEpochToInput(currentStartDateEpoch)} to ${formatDateEpochToInput(currentEndDateEpoch)}...`);

    // Short timeout to allow loader to display before potentially blocking filter logic
    setTimeout(() => {
        const startFilterEpoch = getEpochFromDateString(formatDateEpochToInput(currentStartDateEpoch), 'start');
        const endFilterEpoch = getEpochFromDateString(formatDateEpochToInput(currentEndDateEpoch), 'end');

        const filteredFeatures = fullGeoJsonData.features.filter(feature => {
            if (feature.properties && feature.properties[DATE_PROPERTY_NAME]) {
                const featureEpoch = getEpochFromDateString(feature.properties[DATE_PROPERTY_NAME], 'exact');
                return !isNaN(featureEpoch) && featureEpoch >= startFilterEpoch && featureEpoch <= endFilterEpoch;
            }
            return false;
        });
        const filteredGeoJson = { type: "FeatureCollection", features: filteredFeatures };
        updateMapWithFilteredData(filteredGeoJson);
    }, 20); // Small delay for UI update to show loader text
}

function updateMapWithFilteredData(filteredGeoJson) {
    if (!markerClusterGroup) {
        console.error("markerClusterGroup not initialized for update.");
        hideLoader(0); // Hide immediately
        return;
    }
    markerClusterGroup.clearLayers(); // Clear previous layers
    const featureCount = filteredGeoJson.features.length;

    if (featureCount > 0) {
        const processAsLargeDataset = featureCount > LARGE_DATASET_THRESHOLD;

        // Update text generators for the chunkProgress callback
        chunkProgressTextGenerator = (p, t) => `Updating map: ${Math.round((p/t)*100)}% (${p}/${t} features)`;
        chunkFinalizeTextGenerator = () => `Finalizing filtered map...`;

        if (processAsLargeDataset) {
            // Loader is already shown by filterAndRedrawMap.
            // Text will be updated by chunkProgressCallback if chunking occurs.
            // Set an initial text before chunking might start.
            updateLoaderText('Applying filter, adding features to map...');
        } else {
            // For small datasets, chunkProgress might not fire or fires very quickly.
            updateLoaderText(`Processing ${featureCount} filtered features...`);
        }

        const geoJsonLayer = createGeoJsonLayer(filteredGeoJson);
        markerClusterGroup.addLayer(geoJsonLayer); // This will trigger chunkProgress if applicable

        if (!processAsLargeDataset) {
            // For small datasets, chunking might not happen, or happens in one go.
            // Manually update text and hide loader.
            updateLoaderText(`Displaying ${featureCount} filtered features.`);
            hideLoader();
        }
        // If processAsLargeDataset, sharedChunkProgressCallback will handle final text and hideLoader.
    } else {
        updateLoaderText('No features match filter. Displaying 0 features.');
        hideLoader();
    }
}


// --- Initial Display ---
function displayInitialData(geojsonData) {
    fullGeoJsonData = geojsonData;
    const totalFeatures = geojsonData.features.length;

    // Initialize markerClusterGroup if it doesn't exist (first load)
    if (!markerClusterGroup) {
        markerClusterGroup = createSharedMarkerClusterGroup();
        map.addLayer(markerClusterGroup); // Add to map once
    } else {
        markerClusterGroup.clearLayers(); // Should not happen on truly initial call, but good for robust re-loads
    }

    if (totalFeatures > 0) {
        const processAsLargeDataset = totalFeatures > LARGE_DATASET_THRESHOLD;

        // Update text generators for the chunkProgress callback for initial load
        chunkProgressTextGenerator = (p, t) => `Adding initial features: ${Math.round((p/t)*100)}% (${p}/${t})`;
        chunkFinalizeTextGenerator = () => `Finalizing initial features...`;

        if (processAsLargeDataset) {
            // Loader is likely visible from loadAndDisplayData.
            // Ensure spinner is active and text is updated for large dataset processing.
            showLoader(true, false, 'Adding initial features (large dataset processing)...');
        } else {
            // For small datasets, update text. Loader is already visible.
            updateLoaderText('Processing initial features...');
        }

        const geoJsonLayer = createGeoJsonLayer(geojsonData);
        markerClusterGroup.addLayer(geoJsonLayer); // Triggers chunkProgress if applicable

        const bounds = geoJsonLayer.getBounds();
        if (bounds.isValid()) {
            map.fitBounds(bounds.pad(0.1));
        } else {
            console.warn("Could not determine valid bounds, using default view.");
            map.setView(DEFAULT_EMPTY_MAP_VIEW, DEFAULT_EMPTY_MAP_ZOOM);
        }

        if (!processAsLargeDataset) {
            // For small datasets, manually update text and hide loader
            updateLoaderText(`Displaying ${totalFeatures} features. Map ready.`);
            hideLoader();
        }
        // If processAsLargeDataset, sharedChunkProgressCallback handles final text and hideLoader
    } else {
        updateLoaderText('No initial features to display.');
        map.setView(DEFAULT_EMPTY_MAP_VIEW, DEFAULT_EMPTY_MAP_ZOOM);
        hideLoader();
    }
    initializeDateSliders(); // Initialize sliders after data is processed
}

// --- Main Data Loading ---
async function loadAndDisplayData() {
    showLoader(true, false, 'Initializing application...');
    let dataProcessingAttempted = false;

    try {
        // Brief pause for "Initializing application..." to render
        await new Promise(resolve => setTimeout(resolve, 20));
        updateLoaderText('Fetching geographic data...');
        const response = await fetch(GEOJSON_FILE_PATH);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status} fetching ${GEOJSON_FILE_PATH}`);

        const contentLength = response.headers.get('Content-Length');
        let geojsonData;

        if (contentLength && parseInt(contentLength, 10) > 0) {
            const totalLength = parseInt(contentLength, 10); // Potentially compressed length
            let receivedLength = 0; // Will be uncompressed length
            const reader = response.body.getReader();
            const chunks = [];
            showLoader(false, true, 'Downloading data: 0%'); // Show progress bar
            updateProgressBar(0);

            while (true) {
                const { done, value } = await reader.read(); // value is an uncompressed chunk
                if (done) break;
                chunks.push(value);
                receivedLength += value.length;

                // Cap displayed percentage at 100% if totalLength was compressed size
                const rawPercentage = totalLength > 0 ? (receivedLength / totalLength) * 100 : 0;
                const displayPercentage = Math.min(100, Math.round(rawPercentage));

                updateProgressBar(displayPercentage);
                updateLoaderText(`Downloading data: ${displayPercentage}%`);
            }
            const chunksAll = new Uint8Array(receivedLength);
            let position = 0;
            for (const chunk of chunks) { chunksAll.set(chunk, position); position += chunk.length; }

            showLoader(true, false, 'Parsing downloaded data...'); // Switch back to spinner
            await new Promise(resolve => setTimeout(resolve, 20)); // UI update pause

            const resultText = new TextDecoder("utf-8").decode(chunksAll);
            geojsonData = JSON.parse(resultText);
        } else {
            showLoader(true, false, 'Downloading data (size unknown)...');
            await new Promise(resolve => setTimeout(resolve, 20)); // UI update pause
            geojsonData = await response.json();
            showLoader(true, false, 'Parsing downloaded data...');
            await new Promise(resolve => setTimeout(resolve, 20)); // UI update pause
        }

        dataProcessingAttempted = true;
        if (!geojsonData || !geojsonData.features) {
            console.warn("GeoJSON file loaded but has no features array or is invalid. Using empty dataset.");
            geojsonData = { type: "FeatureCollection", features: [] };
        }

        if (!map) {
            updateLoaderText('Initializing map framework...');
            await new Promise(resolve => setTimeout(resolve, 20)); // UI update pause
            map = L.map(domElements.mapElement);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
                maxZoom: 19
            }).addTo(map);
            console.log("Map framework initialized.");
        }
        displayInitialData(geojsonData);

    } catch (error) {
        console.error("Failed to load or display GeoJSON:", error);
        updateLoaderText(`Error: ${error.message}. Check console for details.`);
        dataProcessingAttempted = true;
        if (!map && domElements.mapElement) { // Initialize a basic map if one doesn't exist
             map = L.map(domElements.mapElement).setView(DEFAULT_EMPTY_MAP_VIEW, DEFAULT_EMPTY_MAP_ZOOM);
             L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OSM contributors'}).addTo(map);
             console.warn("Map initialized to default view due to data loading error.");
        }
        hideLoader(0); // Hide loader immediately after showing error message
    } finally {
        // Failsafe: if loader is still visible after processing and not showing a final/error message
        if (dataProcessingAttempted && domElements.loaderContainer && !domElements.loaderContainer.classList.contains('hidden')) {
            const currentText = domElements.loaderText ? domElements.loaderText.textContent.toLowerCase() : "";
            const isFinalMessageContext = currentText.includes("finalizing") ||
                                   currentText.includes("map ready") ||
                                   currentText.includes("displaying") ||
                                   currentText.startsWith("error") ||
                                   currentText.includes("no features"); // Add other relevant "final state" texts
            if (!isFinalMessageContext) {
                console.warn("Loader still visible in finally without an expected final message. Hiding as failsafe. Text was:", domElements.loaderText.textContent);
                hideLoader(200); // Slightly longer delay for failsafe hide
            }
        }
        if (domElements.progressBar) updateProgressBar(0); // Reset progress bar visuals
    }
}

// --- Event Listener for DOM Ready ---
document.addEventListener('DOMContentLoaded', () => {
    domElements = {
        loaderContainer: document.getElementById('loader-container'),
        spinner: document.querySelector('#loader-container .spinner'),
        progressInfo: document.getElementById('progress-info'),
        progressBar: document.getElementById('progress-bar'),
        loaderText: document.getElementById('loader-text'),
        dateFilterControls: document.getElementById('date-filter-controls'),
        startDateSlider: document.getElementById('startDateSlider'),
        endDateSlider: document.getElementById('endDateSlider'),
        startDateValueDisplay: document.getElementById('startDateValue'),
        endDateValueDisplay: document.getElementById('endDateValue'),
        mapElement: document.getElementById('map')
    };

    // Check if all critical DOM elements are found
    const missingElements = Object.entries(domElements).filter(([key, el]) => !el);
    if (missingElements.length > 0) {
        const missingElementIds = missingElements.map(([key]) => key).join(', ');
        console.error(`Critical HTML element(s) missing: ${missingElementIds}. Check IDs in index.html.`);
        if(domElements.loaderContainer) { // Attempt to show error in loader
            updateLoaderText(`Error: UI elements missing (${missingElementIds}). App cannot start.`);
            if(domElements.spinner) domElements.spinner.classList.add('hidden');
            if(domElements.progressInfo) domElements.progressInfo.classList.add('hidden');
        } else { // Fallback if even loader is missing
            alert(`Error: Critical UI elements (${missingElementIds}) are missing. The application cannot start correctly.`);
        }
        return;
    }
    loadAndDisplayData();
});