// parse_worker.js (Simplified Version - Updated for existing geometry in array items)
self.onmessage = function(e) {

    const { geoJsonStrings, datePropertyName } = e.data;
    let allFeatures = [];

    for (const geoJsonString of geoJsonStrings) {
        // Assuming geoJsonString is a non-empty, valid JSON string.
        let parsedData;
        try {
            parsedData = JSON.parse(geoJsonString);
        } catch (error) {
            // This block should ideally not be hit if all assumptions about input validity hold.
            console.error("[PARSE_WORKER] Error parsing a GeoJSON string (was assumed to be perfectly valid JSON):", error, "String snippet (first 100 chars):", geoJsonString.substring(0, 100));
            continue; // Skip this problematic string
        }

        if (parsedData && parsedData.type === "FeatureCollection" && Array.isArray(parsedData.features)) {
            // Assuming if type is "FeatureCollection", .features is a valid array of features.
            allFeatures = allFeatures.concat(parsedData.features);
        } else if (Array.isArray(parsedData)) {
            // Assuming this is an array of objects, each intended to become a GeoJSON Feature.
            // Each item should already have its own `geometry` object.
            const transformedFeatures = parsedData.map(item => {
                // Basic check: item is an object and has `geometry` with `coordinates`.
                if (item && typeof item === 'object' && item.geometry && Array.isArray(item.geometry.coordinates)) {
                    const { geometry, ...otherProperties } = item; // Destructure to separate geometry from the rest

                    const properties = { ...otherProperties }; // Use remaining item keys as properties

                    // Apply date property logic:
                    // If `properties` (derived from `item`) has a 'date' field,
                    // ensure `properties[datePropertyName]` gets this value.
                    if (properties.hasOwnProperty('date')) {
                        properties[datePropertyName] = properties.date;
                    }

                    return {
                        type: "Feature",
                        geometry: geometry, // Use the existing geometry object directly
                        properties: properties
                    };
                } else {
                    // This implies an item in the array did not conform to the expected structure
                    // (i.e., having `item.geometry.coordinates`).
                    console.warn("[PARSE_WORKER] Skipping item in array: item is not an object, or missing 'geometry', or 'geometry.coordinates'. Item:", JSON.stringify(item));
                    return null; // Mark for filtering
                }
            }).filter(Boolean); // Remove any nulls from items that couldn't be transformed
            allFeatures = allFeatures.concat(transformedFeatures);
        } else {
            // This block should ideally not be hit if the input always matches one of the expected formats.
            console.warn("[PARSE_WORKER] Parsed data was neither a FeatureCollection nor an array of objects (input was assumed to be one of these):", parsedData);
        }
    }

    // console.log("[PARSE_WORKER] Parsing complete. Total features extracted:", allFeatures.length); // Optional
    self.postMessage({ type: 'success', data: { type: "FeatureCollection", features: allFeatures } });
};