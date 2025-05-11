// filter_worker.js

// This helper function is self-contained within the worker.
// It's designed to parse date strings found in feature properties.
function getEpochFromFeatureDateString(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return NaN;

    // If 'YYYY-MM-DD', assume UTC start of day.
    if (dateStr.length === 10 && dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
        return new Date(dateStr + 'T00:00:00.000Z').getTime();
    }
    // Otherwise, attempt to parse as a full ISO string or other Date-parsable format.
    // Date.parse() or new Date() handle ISO 8601 (which includes 'Z' for UTC) correctly.
    const epoch = new Date(dateStr).getTime();
    return epoch; // Will be NaN if unparsable
}

self.onmessage = function(e) {
    const { features, datePropertyName, startFilterEpoch, endFilterEpoch } = e.data;

    if (!features || !datePropertyName || startFilterEpoch === undefined || endFilterEpoch === undefined) {
        self.postMessage({ type: 'error', message: 'Missing required data for filtering worker.' });
        return;
    }

    try {
        const filteredFeatures = features.filter(feature => {
            if (feature.properties && feature.properties[datePropertyName]) {
                const featureEpoch = getEpochFromFeatureDateString(feature.properties[datePropertyName]);
                return !isNaN(featureEpoch) && featureEpoch >= startFilterEpoch && featureEpoch <= endFilterEpoch;
            }
            return false;
        });
        self.postMessage({ type: 'success', data: filteredFeatures });
    } catch (error) {
        self.postMessage({ type: 'error', message: `Filtering failed: ${error.message}`, name: error.name });
    }
    // self.close(); // Filter worker might be re-used, so typically not closed here unless managed by main thread
};