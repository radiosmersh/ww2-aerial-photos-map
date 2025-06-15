// parse_worker.js
self.onmessage = function(e) {
    // --- TARGETED LOGGING ON RECEIPT ---
    console.log("[PARSE_WORKER] Received message. Full e.data object:", e.data); // Should be an object: { geoJsonStrings: [...], datePropertyName: "..." }
    if (e.data && e.data.hasOwnProperty('geoJsonStrings')) { // Check if property exists
        const receivedStrings = e.data.geoJsonStrings;
        console.log("[PARSE_WORKER] e.data.geoJsonStrings received. Type:", typeof receivedStrings, "Is Array:", Array.isArray(receivedStrings));
        if (Array.isArray(receivedStrings)) {
            console.log("[PARSE_WORKER] Length of received geoJsonStrings:", receivedStrings.length);
            if (receivedStrings.length > 0 && typeof receivedStrings[0] === 'string') {
                console.log("[PARSE_WORKER] Snippet of first string in received array:", receivedStrings[0].substring(0, 50) + (receivedStrings[0].length > 50 ? "..." : ""));
            } else if (receivedStrings.length > 0) {
                console.log("[PARSE_WORKER] First element in received array is not a string. Type:", typeof receivedStrings[0]);
            }
        }
    } else {
        // This block should NOT be hit if the minimal worker test was fine
        console.error("[PARSE_WORKER] e.data is problematic or does not contain geoJsonStrings. e.data:", e.data);
    }
    // --- END TARGETED LOGGING ---

    // Original destructuring:
    // This is where things might go wrong if e.data is not what's expected,
    // despite the logs above potentially showing it's okay.
    const { geoJsonStrings, datePropertyName } = e.data;

    // Log values AFTER destructuring
    console.log("[PARSE_WORKER] After destructuring: geoJsonStrings type:", typeof geoJsonStrings, "Is Array:", Array.isArray(geoJsonStrings));
    if(Array.isArray(geoJsonStrings)) {
        console.log("[PARSE_WORKER] After destructuring: geoJsonStrings length:", geoJsonStrings.length);
    }


    if (!geoJsonStrings || !Array.isArray(geoJsonStrings) || geoJsonStrings.length === 0) {
        console.error("[PARSE_WORKER] Condition for error met. Actual geoJsonStrings variable after destructuring:", geoJsonStrings);
        self.postMessage({ type: 'error', message: 'No GeoJSON strings array received by parser worker.' });
        return;
    }

    console.log("[PARSE_WORKER] Proceeding with parsing. Number of strings to parse:", geoJsonStrings.length); // New log
    let allFeatures = [];

    for (const geoJsonString of geoJsonStrings) {
        if (!geoJsonString || typeof geoJsonString !== 'string' || geoJsonString.trim() === "") {
            console.warn("[PARSE_WORKER] Skipping empty, null, or non-string item in geoJsonStrings array:", geoJsonString);
            continue;
        }
        console.log("[PARSE_WORKER] Attempting to parse string (first 70 chars):", geoJsonString.substring(0,70)); // New log
        try {
            const parsedData = JSON.parse(geoJsonString);

            if (parsedData && parsedData.type === "FeatureCollection" && Array.isArray(parsedData.features)) {
                allFeatures = allFeatures.concat(parsedData.features);
            }
            else if (Array.isArray(parsedData)) {
                const transformedFeatures = parsedData.map(item => {
                    if (item.latitude !== undefined && item.longitude !== undefined) {
                        const properties = { ...item };
                        if (item.date && datePropertyName !== 'date') {
                             properties[datePropertyName] = item.date;
                        } else if (!item[datePropertyName] && item.date) {
                            properties[datePropertyName] = item.date;
                        }
                        return {
                            type: "Feature",
                            geometry: {
                                type: "Point",
                                coordinates: [parseFloat(item.longitude), parseFloat(item.latitude)]
                            },
                            properties: properties
                        };
                    } else {
                        console.warn("[PARSE_WORKER] Skipping item in GeoJSON array due to missing lat/lon:", item);
                        return null;
                    }
                }).filter(Boolean);
                allFeatures = allFeatures.concat(transformedFeatures);
            } else {
                console.warn("[PARSE_WORKER] Parsed data is not a valid FeatureCollection or array:", parsedData);
            }
        } catch (error) {
            console.error("[PARSE_WORKER] Error parsing a GeoJSON string in worker:", error, "String was (first 100 chars):", geoJsonString.substring(0,100));
            // To avoid stopping the whole worker on one bad string, you might consider just continuing the loop.
            // For now, it will continue.
        }
    }
    console.log("[PARSE_WORKER] Parsing complete. Total features extracted:", allFeatures.length); // New log
    self.postMessage({ type: 'success', data: { type: "FeatureCollection", features: allFeatures } });
};