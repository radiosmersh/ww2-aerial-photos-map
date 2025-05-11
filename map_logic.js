// --- Configuration ---
const GEOJSON_FILE_PATH = 'scans.geojson'; // Your GeoJSON file
const INITIAL_MAP_VIEW = [51.505, -0.09];
const INITIAL_MAP_ZOOM = 6;

// --- DOM Elements ---
let loaderContainer;

// --- Map Initialization ---
let map;

// --- Helper Function to Create Popup Content ---
function createPopupContent(properties) {
    let content = ``;
    if (properties.name) {
        content += `<b>${properties.name}</b><br>`;
    }
    if (properties.date) {
        content += `Date: ${properties.date}<br>`;
    }
    if (properties.scale) {
        content += `Scale: ${properties.scale}<br>`;
    }
    if (properties.naId) {
        content += `NARA ID: <a href="https://catalog.archives.gov/id/${properties.naId}" target="_blank" rel="noopener noreferrer">${properties.naId}</a><br>`;
    }
    if (properties.objectUrl) {
        content += `<a href="${properties.objectUrl}" target="_blank" rel="noopener noreferrer">View Full Image</a><br>`;
        if (/\.(jpeg|jpg|gif|png)$/i.test(properties.objectUrl)) {
             content += `<img src="${properties.objectUrl}" alt="Preview Image" class="popup-image">`; // Changed alt text slightly
        }
    }
    return content || "No details available.";
}

// --- Clustering Strategy Function ---
function displayClusteredPoints(geojsonData) {
    console.log("Applying Clustering Strategy...");

    const markers = L.markerClusterGroup({
        chunkedLoading: true,
        maxClusterRadius: 70,
    });

    const geoJsonLayer = L.geoJSON(geojsonData, {
        onEachFeature: function (feature, layer) {
            if (feature.properties) {
                // MODIFICATION: Add options to bindPopup, specifically maxWidth
                layer.bindPopup(createPopupContent(feature.properties), {
                    maxHeight: 200,
                    maxWidth: 200,  // <-- Increase this value to allow wider popups.
                                    // Try values like 250, 300, or 350 to see what works best
                                    // for your content (image width + text + padding).
                    // maxHeight: 350, // Optional: if vertical space is also an issue
                    // className: 'custom-leaflet-popup' // Optional: for further CSS styling of the popup itself
                });
            }
        }
    });

    markers.addLayer(geoJsonLayer);
    map.addLayer(markers);

    if (geojsonData && geojsonData.features && geojsonData.features.length > 0) {
        const bounds = geoJsonLayer.getBounds();
        if (bounds.isValid()) {
            map.fitBounds(bounds.pad(0.1));
            console.log("Map fitted to data bounds.");
        } else {
            console.warn("Could not determine valid bounds from GeoJSON data.");
        }
    } else {
        console.warn("GeoJSON data is empty or has no features to determine bounds.");
    }
}

// --- Main Function to Load Data and Apply Strategy ---
async function loadAndDisplayData() {
    if (!loaderContainer) {
        console.error("Loader container not found!");
        return;
    }
    loaderContainer.classList.remove('hidden');

    try {
        console.log(`Fetching GeoJSON data from: ${GEOJSON_FILE_PATH}`);
        const response = await fetch(GEOJSON_FILE_PATH);

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status} while fetching ${GEOJSON_FILE_PATH}`);
        }
        const geojsonData = await response.json();
        console.log(`Successfully loaded ${geojsonData.features ? geojsonData.features.length : 0} features.`);

        if (!geojsonData || !geojsonData.features || geojsonData.features.length === 0) {
            alert("GeoJSON file loaded but appears to contain no features. Please check the file content.");
            console.warn("GeoJSON data is empty or has no features.");
            return;
        }

        displayClusteredPoints(geojsonData);

    } catch (error) {
        console.error("Failed to load or display GeoJSON:", error);
        alert(`Error loading or processing GeoJSON from '${GEOJSON_FILE_PATH}'.\n\nDetails: ${error.message}\n\nPlease check the console for more information and ensure the file path is correct and accessible (e.g., use a local web server if running from file://).`);
    } finally {
        loaderContainer.classList.add('hidden');
        console.log("Loader hidden.");
    }
}

// --- Start the application ---
document.addEventListener('DOMContentLoaded', () => {
    map = L.map('map').setView(INITIAL_MAP_VIEW, INITIAL_MAP_ZOOM);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', // Corrected to ©
        maxZoom: 19
    }).addTo(map);

    loaderContainer = document.getElementById('loader-container');
    if (!loaderContainer) {
        console.error("Loader container element with ID 'loader-container' not found in the HTML.");
        return;
    }

    loadAndDisplayData();
});