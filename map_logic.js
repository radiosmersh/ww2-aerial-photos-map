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
// REMOVED: const LOADER_FINALIZE_DELAY = 300; 

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

function hideLoader(delay = 100) { 
    if (!domElements.loaderContainer || domElements.loaderContainer.classList.contains('hidden')) return;
    
    setTimeout(() => {
        if (domElements.loaderContainer) { 
            domElements.loaderContainer.classList.add('hidden');
            console.log("Loader hidden. Delay:", delay, "Final text:", domElements.loaderText.textContent);
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
    else if (dateStr.length === 10) fullDateStr += 'T00:00:00Z'; 
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
        if (properties[ORIGIN_PROPERTY_NAME] === 1) {
            originText = "German";
        } else if (properties[ORIGIN_PROPERTY_NAME] === 2) {
            originText = "Allied";
        }
        content += `Origin: ${originText}<br>`;
    }

    if (properties.date) content += `Date: ${properties.date}<br>`;
    if (properties.scale) content += `Scale: ${properties.scale}<br>`;
    if (properties.naId) {
        content += `NARA ID: <a href="https://catalog.archives.gov/id/${properties.naId}" target="_blank" rel="noopener noreferrer">${properties.naId}</a><br>`;
    }
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

function createMarkerClusterGroup(useChunkProgress, progressCallbackTextPrefix = "Adding features", onCompleteAction = null) {
    function chunkProgressCallback(processed, total) {
        if (processed < total) {
            const percentage = Math.round((processed / total) * 100);
            updateLoaderText(`${progressCallbackTextPrefix}: ${percentage}% (${processed}/${total})`);
        } else {
            updateLoaderText(`Finalizing ${progressCallbackTextPrefix.toLowerCase().replace('adding ', '')}...`);
            if (onCompleteAction) {
                // Default delay (100ms) or specific delay passed to hideLoader() via onCompleteAction
                setTimeout(onCompleteAction, 50); // Small delay for text update before action
            }
        }
    }
    return L.markerClusterGroup({
        chunkedLoading: true,
        maxClusterRadius: 70,
        chunkProgress: useChunkProgress ? chunkProgressCallback : null
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
    console.log("Date sliders initialized.");
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
}

function updateMapWithFilteredData(filteredGeoJson) {
    if (!markerClusterGroup) {
        console.error("markerClusterGroup not initialized for update.");
        hideLoader(0);
        return;
    }
    markerClusterGroup.clearLayers();

    const featureCount = filteredGeoJson.features.length;
    updateLoaderText(featureCount > 0 ? 'Preparing to update map features...' : 'No features match filter.');

    if (featureCount > 0) {
        const useChunkProgressForUpdate = featureCount > LARGE_DATASET_THRESHOLD;
        
        const mcgOptionsForUpdate = createMarkerClusterGroup(
            useChunkProgressForUpdate,
            "Updating map features",
            () => hideLoader() // Use default hideLoader delay (100ms)
        ).options;

        markerClusterGroup.options.chunkProgress = mcgOptionsForUpdate.chunkProgress;

        const geoJsonLayer = createGeoJsonLayer(filteredGeoJson);
        markerClusterGroup.addLayer(geoJsonLayer);

        if (!useChunkProgressForUpdate) { 
            updateLoaderText(`Displaying ${featureCount} features.`);
            hideLoader(); 
        }
    } else { 
        updateLoaderText(`Displaying 0 features.`);
        hideLoader(); 
    }
}


// --- Initial Display ---
function displayInitialData(geojsonData) {
    fullGeoJsonData = geojsonData;
    updateLoaderText('Preparing map layers...');

    const totalFeatures = geojsonData.features.length;
    const useChunkProgressForInitial = totalFeatures > LARGE_DATASET_THRESHOLD;

    if (markerClusterGroup && map.hasLayer(markerClusterGroup)) {
        map.removeLayer(markerClusterGroup);
    }

    markerClusterGroup = createMarkerClusterGroup(
        useChunkProgressForInitial,
        "Adding initial map features",
        () => { 
            console.log("Initial chunking reported complete by L.markercluster.");
            hideLoader(); // Use default hideLoader delay (100ms)
        }
    );

    const geoJsonLayer = createGeoJsonLayer(geojsonData);
    markerClusterGroup.addLayer(geoJsonLayer); 
    map.addLayer(markerClusterGroup);

    if (totalFeatures > 0) {
        const bounds = geoJsonLayer.getBounds();
        if (bounds.isValid()) {
            map.fitBounds(bounds.pad(0.1));
        } else {
            console.warn("Could not determine valid bounds from data, using default view.");
            map.setView(DEFAULT_EMPTY_MAP_VIEW, DEFAULT_EMPTY_MAP_ZOOM);
        }
    } else {
        updateLoaderText('No initial features to display.');
        map.setView(DEFAULT_EMPTY_MAP_VIEW, DEFAULT_EMPTY_MAP_ZOOM);
        if (!useChunkProgressForInitial) {
            hideLoader(); 
        }
    }

    initializeDateSliders(); 

    if (!useChunkProgressForInitial && totalFeatures > 0) {
        updateLoaderText('Map ready.');
        hideLoader(); 
    }
}

// --- Main Data Loading ---
async function loadAndDisplayData() {
    showLoader(true, false, 'Initializing...');
    let dataProcessingAttempted = false; 

    try {
        const response = await fetch(GEOJSON_FILE_PATH);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status} fetching ${GEOJSON_FILE_PATH}`);

        const contentLength = response.headers.get('Content-Length');
        let geojsonData;

        if (contentLength && parseInt(contentLength, 10) > 0) {
            const totalLength = parseInt(contentLength, 10);
            let receivedLength = 0;
            const reader = response.body.getReader();
            const chunks = [];
            showLoader(false, true, 'Downloading data: 0%');
            updateProgressBar(0);

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                receivedLength += value.length;
                const percentage = Math.round((receivedLength / totalLength) * 100);
                updateProgressBar(percentage);
                updateLoaderText(`Downloading data: ${percentage}%`);
            }
            const chunksAll = new Uint8Array(receivedLength);
            let position = 0;
            for (const chunk of chunks) { chunksAll.set(chunk, position); position += chunk.length; }
            
            showLoader(true, false, 'Parsing downloaded data...');
            await new Promise(resolve => setTimeout(resolve, 50)); 

            const resultText = new TextDecoder("utf-8").decode(chunksAll);
            geojsonData = JSON.parse(resultText);
        } else {
            showLoader(true, false, 'Downloading data (size unknown)...');
            console.warn('Content-Length not available.');
            geojsonData = await response.json();
            showLoader(true, false, 'Parsing downloaded data...');
            await new Promise(resolve => setTimeout(resolve, 50)); 
        }
        
        dataProcessingAttempted = true;

        if (!geojsonData || !geojsonData.features) {
            console.warn("GeoJSON file loaded but has no features array or is invalid.");
            geojsonData = { type: "FeatureCollection", features: [] };
        }

        if (!map) { 
            updateLoaderText('Initializing map interface...');
            await new Promise(resolve => setTimeout(resolve, 50));
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
        updateLoaderText('Error loading data!');
        alert(`Error: ${error.message}. Check console.`);
        dataProcessingAttempted = true; 
        if (!map && domElements.mapElement) { 
             map = L.map(domElements.mapElement).setView(DEFAULT_EMPTY_MAP_VIEW, DEFAULT_EMPTY_MAP_ZOOM);
             L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OSM contributors'}).addTo(map);
             console.warn("Map initialized to default view due to data loading error.");
        }
        hideLoader(0); 
    } finally {
        if (dataProcessingAttempted && domElements.loaderContainer && !domElements.loaderContainer.classList.contains('hidden')) {
            const currentText = domElements.loaderText ? domElements.loaderText.textContent : "";
            if (!currentText.toLowerCase().includes("finalizing") && 
                !currentText.toLowerCase().includes("map ready") && 
                !currentText.toLowerCase().includes("displaying") &&
                !currentText.toLowerCase().startsWith("error")) { // Don't hide if error text is showing
                console.warn("Loader still visible in finally after data processing. Hiding as failsafe. Text was:", currentText);
                hideLoader(150); // Failsafe delay, slightly longer than default hideLoader
            } else {
                console.log("Loader hiding assumed to be handled by onCompleteAction or explicit calls. Final text:", currentText);
            }
        }
        if (domElements.progressBar) updateProgressBar(0);
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

    const criticalElements = [
        domElements.loaderContainer, domElements.mapElement, domElements.dateFilterControls,
        domElements.startDateSlider, domElements.endDateSlider, domElements.startDateValueDisplay, domElements.endDateValueDisplay,
        domElements.spinner, domElements.progressInfo, domElements.progressBar, domElements.loaderText
    ];
    if (criticalElements.some(el => !el)) {
        console.error("One or more critical HTML elements are missing! Check IDs in index.html.");
        alert("Error: Critical UI elements are missing. The application cannot start correctly.");
        if(domElements.loaderContainer) domElements.loaderContainer.classList.add('hidden');
        return;
    }
    loadAndDisplayData();
});