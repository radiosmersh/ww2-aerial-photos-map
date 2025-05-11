// parse_worker.js
self.onmessage = function(e) {
    const { geoJsonString } = e.data;
    if (!geoJsonString) {
        self.postMessage({ type: 'error', message: 'No GeoJSON string received by parser worker.' });
        return;
    }
    try {
        const parsedData = JSON.parse(geoJsonString);
        self.postMessage({ type: 'success', data: parsedData });
    } catch (error) {
        self.postMessage({ type: 'error', message: `JSON parsing failed: ${error.message}`, name: error.name });
    }
    // self.close(); // Optional: close worker if it's truly one-shot, but usually kept for potential reuse or if parsing multiple files. For this app, it's one shot.
};