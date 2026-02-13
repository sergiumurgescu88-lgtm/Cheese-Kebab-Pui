
import { GoogleGenAI, Type, FunctionDeclaration, GenerateContentResponse } from "@google/genai";
import { searchPlaces } from "./googleMapsService";
import { analyzeRoofImage } from "./annoBananaService";
import { createSimulationJob, getLicenseInfo } from "./pvsystService";
import { searchParks } from "./solarParkData";
import { 
  SYSTEM_INSTRUCTION_RO, 
  SYSTEM_INSTRUCTION_EN, 
  GEMINI_PRO_MODEL_ID, 
  GEMINI_FLASH_MODEL_ID, 
  GEMINI_MAPS_MODEL_ID,
  DEFAULT_MODEL_ID,
  GEMINI_IMAGE_GEN_MODEL_ID,
  GEMINI_IMAGE_EDIT_MODEL_ID
} from "../constants";
import { ImageSize, Language, Attachment, GroundingSource } from "../types";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function withRetry<T>(fn: () => Promise<T>, retries = 2, baseDelay = 2000): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    const isRateLimit = e.message?.includes('429') || e.message?.includes('RESOURCE_EXHAUSTED') || e.status === 429 || e.status === 503;
    if (retries > 0 && isRateLimit) {
      const waitTime = baseDelay * (3 - retries); 
      console.warn(`[Gemini] Rate limit hit. Retrying in ${waitTime}ms...`);
      await delay(waitTime);
      return withRetry(fn, retries - 1, baseDelay);
    }
    throw e;
  }
}

const BACKEND = 'http://localhost:3001/api';

const fetchJson = async (endpoint: string, options: any = {}) => {
    try {
        const res = await fetch(`${BACKEND}${endpoint}`, options);
        if (!res.ok) throw new Error(`Backend Error ${res.status}`);
        return await res.json();
    } catch (e: any) {
        return { error: `Backend connection failed: ${e.message}`, isConnectionError: true };
    }
};

// --- GOOGLE CLOUD API TOOLS (PERSONA IMPLEMENTATION) ---

const fetchGoogleWeatherTool: FunctionDeclaration = {
    name: "fetch_google_weather",
    description: "Get current and forecasted weather data using Google Weather API.",
    parameters: {
        type: Type.OBJECT,
        properties: {
            location: { type: Type.STRING, description: "Lat,Lng or City Name" },
            days: { type: Type.NUMBER, default: 5 }
        },
        required: ["location"]
    }
};

const fetchGoogleSolarTool: FunctionDeclaration = {
    name: "fetch_google_solar",
    description: "Access Google Solar API to get advanced photovoltaic potential, roof segment analysis, and shading data.",
    parameters: {
        type: Type.OBJECT,
        properties: {
            latitude: { type: Type.NUMBER },
            longitude: { type: Type.NUMBER },
            quality: { type: Type.STRING, enum: ["HIGH", "MEDIUM", "LOW"], default: "HIGH" }
        },
        required: ["latitude", "longitude"]
    }
};

const fetchGoogleAirQualityTool: FunctionDeclaration = {
    name: "fetch_google_air_quality",
    description: "Retrieve air quality index (AQI) and pollutants (PM2.5, PM10, NO2) via Google Air Quality API (500m resolution).",
    parameters: {
        type: Type.OBJECT,
        properties: {
            latitude: { type: Type.NUMBER },
            longitude: { type: Type.NUMBER }
        },
        required: ["latitude", "longitude"]
    }
};

const fetchGooglePollenTool: FunctionDeclaration = {
    name: "fetch_google_pollen",
    description: "Get pollen data (Grass, Tree, Weed) via Google Pollen API (1km resolution). Critical for biodiversity and soiling analysis.",
    parameters: {
        type: Type.OBJECT,
        properties: {
            latitude: { type: Type.NUMBER },
            longitude: { type: Type.NUMBER },
            days: { type: Type.NUMBER, default: 3 }
        },
        required: ["latitude", "longitude"]
    }
};

const queryMapsDatasetsTool: FunctionDeclaration = {
    name: "query_maps_datasets",
    description: "Query uploaded geospatial datasets (Helios Internal Assets) via Google Maps Datasets API.",
    parameters: {
        type: Type.OBJECT,
        properties: {
            datasetId: { type: Type.STRING },
            spatialFilter: { type: Type.STRING }
        },
        required: ["datasetId"]
    }
};

const fetchStreetViewTool: FunctionDeclaration = {
    name: "fetch_street_view",
    description: "Retrieve 360-degree imagery metadata and connectivity via Street View Publish API.",
    parameters: {
        type: Type.OBJECT,
        properties: {
            location: { type: Type.STRING },
            radius: { type: Type.NUMBER, default: 50 }
        },
        required: ["location"]
    }
};

// --- HELIOS CORE TOOLS ---

const generateSiteReportTool: FunctionDeclaration = {
    name: "generate_technical_site_report",
    description: "Synthesize all current site data into a high-level executive report.",
    parameters: {
        type: Type.OBJECT,
        properties: {
            siteName: { type: Type.STRING },
            telemetrySummary: { type: Type.STRING },
            tone: { type: Type.STRING, default: "executive" }
        },
        required: ["siteName", "telemetrySummary"]
    }
};

const fetchPlanetImageryTool: FunctionDeclaration = {
    name: "fetch_planet_imagery",
    description: "Fetch ultra-high-resolution satellite imagery via Planet Labs Subscriptions API.",
    parameters: {
        type: Type.OBJECT,
        properties: {
            name: { type: Type.STRING },
            coordinates: { type: Type.ARRAY, items: { type: Type.NUMBER } },
            source: { type: Type.STRING, enum: ["planetscope", "skysat"], default: "planetscope" },
            startDate: { type: Type.STRING },
            spectralBands: { type: Type.ARRAY, items: { type: Type.STRING } },
            spectralAnalysis: { type: Type.STRING }
        },
        required: ["coordinates", "startDate"]
    }
};

const executeEnergyTradeTool: FunctionDeclaration = {
    name: "execute_energy_trade",
    description: "Execute or simulate an algorithmic energy trade on the OPCOM/Day-Ahead market.",
    parameters: {
        type: Type.OBJECT,
        properties: {
            action: { type: Type.STRING, enum: ["BUY", "SELL", "HOLD"] },
            volumeMwh: { type: Type.NUMBER },
            priceLimit: { type: Type.NUMBER }
        },
        required: ["action", "volumeMwh"]
    }
};

const analyzePredictiveFailureTool: FunctionDeclaration = {
    name: "analyze_predictive_failure",
    description: "Run LSTM models to predict component failures.",
    parameters: {
        type: Type.OBJECT,
        properties: { parkId: { type: Type.STRING }, horizonDays: { type: Type.NUMBER } },
        required: ["parkId"]
    }
};

const planAgrivoltaicsTool: FunctionDeclaration = {
    name: "plan_agrivoltaics",
    description: "Generate an agricultural compatibility report.",
    parameters: {
        type: Type.OBJECT,
        properties: { location: { type: Type.STRING }, cropType: { type: Type.STRING } },
        required: ["location"]
    }
};

const searchPlacesTool: FunctionDeclaration = {
  name: "searchPlaces",
  description: "Search for a physical location via Google Maps backend.",
  parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING } }, required: ["query"] },
};

const searchSolarParksTool: FunctionDeclaration = {
  name: "searchSolarParks",
  description: "Search internal Helios SCADA database for operational solar assets.",
  parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING } }, required: ["query"] },
};

// --- IMPLEMENTATION HELPERS (MOCKED FOR DEMO TO SIMULATE GOOGLE APIs) ---

export const fetchGoogleWeather = async (args: any) => {
    // Simulating Google Weather API response with high fidelity for Solar usage
    const location = args.location || "Bucharest";
    return {
        source: "Google Weather API",
        location: {
            name: location,
            region: "Muntenia",
            country: "Romania",
            lat: 44.43,
            lon: 26.10,
            tz_id: "Europe/Bucharest"
        },
        current: {
            last_updated: new Date().toISOString(),
            temp_c: 24.5,
            condition: {
                text: "Partly cloudy",
                icon: "//cdn.weatherapi.com/weather/64x64/day/116.png",
                code: 1003
            },
            wind_kph: 12.6,
            wind_degree: 340,
            wind_dir: "NNW",
            pressure_mb: 1015.0,
            precip_mm: 0.0,
            humidity: 42,
            cloud: 25,
            feelslike_c: 25.1,
            vis_km: 10.0,
            uv: 6.0,
            gust_kph: 15.4
        },
        forecast: {
            forecastday: [
                {
                    date: "2024-05-20",
                    day: {
                        maxtemp_c: 26.8,
                        mintemp_c: 14.3,
                        avgtemp_c: 21.0,
                        maxwind_kph: 18.4,
                        totalprecip_mm: 0.0,
                        avgvis_km: 10.0,
                        avghumidity: 45,
                        condition: {
                            text: "Sunny",
                            icon: "//cdn.weatherapi.com/weather/64x64/day/113.png",
                            code: 1000
                        },
                        uv: 7.0
                    },
                    hour: [
                         { time: "08:00", temp_c: 18.2, cloud: 10, chance_of_rain: 0, shortwave_radiation: 450.2 },
                         { time: "12:00", temp_c: 25.1, cloud: 5, chance_of_rain: 0, shortwave_radiation: 950.8 },
                         { time: "16:00", temp_c: 23.4, cloud: 20, chance_of_rain: 10, shortwave_radiation: 600.5 }
                    ]
                }
            ]
        },
        alerts: []
    };
};

export const fetchGoogleSolar = async (args: any) => {
    // Simulating Google Solar API response
    // Enhanced mock with roof segment details
    return {
        source: "Google Solar API",
        buildingInsights: {
            name: "Solar Potential Analysis",
            center: { lat: args.latitude, lng: args.longitude },
            solarPotential: {
                maxArrayPanelsCount: 1250,
                maxArrayAreaMeters2: 2400,
                maxSunshineHoursPerYear: 1650,
                carbonOffsetFactorKgPerMwh: 450,
                wholeRoofStats: {
                    areaMeters2: 2600,
                    sunshineQuantiles: [1400, 1550, 1680, 1720]
                },
                roofSegmentStats: [
                     { pitchDegrees: 25, azimuthDegrees: 180, stats: { areaMeters2: 1200, sunshineQuantiles: [1600, 1750] } },
                     { pitchDegrees: 25, azimuthDegrees: 90, stats: { areaMeters2: 800, sunshineQuantiles: [1300, 1450] } }
                ],
                financialAnalysis: {
                    monthlyBill: { currencyCode: "EUR", units: 4500, nanos: 0 },
                    defaultBill: true,
                    financialDetails: { initialAcKwhPerYear: 320000, remainingLifetimeUtilityBillPayments: { units: 150000, nanos: 0 } }
                }
            }
        },
        dataLayers: ["dsm", "rgb", "mask", "annual_flux"]
    };
};

export const fetchGoogleAirQuality = async (args: any) => {
    return {
        source: "Google Air Quality API",
        location: { lat: args.latitude, lng: args.longitude },
        indexes: [
            { code: "upi", displayName: "Universal Pollutant Index", aqi: 45, category: "Good" }
        ],
        pollutants: [
            { code: "pm10", concentration: { value: 22, units: "ug/m3" } },
            { code: "no2", concentration: { value: 12, units: "ug/m3" } }
        ]
    };
};

export const fetchGooglePollen = async (args: any) => {
    // Simulating Google Pollen API response (1x1km resolution)
    // Critical for Agrivoltaics and "Bio-Soiling" (pollen sticking to panels reducing efficiency)
    return {
        source: "Google Pollen API",
        location: { lat: args.latitude, lng: args.longitude },
        dailyInfo: [
            {
                date: new Date().toISOString().split('T')[0],
                pollenTypeInfo: [
                    {
                        code: "GRASS",
                        displayName: "Graminales",
                        inSeason: true,
                        indexInfo: {
                            value: 2,
                            category: "Low",
                            indexDescription: "Low concentration of grass pollen."
                        },
                        plantInfo: [
                            { code: "POA", displayName: "Bluegrass", inSeason: true }
                        ]
                    },
                    {
                        code: "TREE",
                        displayName: "Trees",
                        inSeason: true,
                        indexInfo: {
                            value: 4,
                            category: "Moderate",
                            indexDescription: "Moderate concentration of tree pollen."
                        },
                        plantInfo: [
                            { code: "BETULA", displayName: "Birch", inSeason: true },
                            { code: "QUERCUS", displayName: "Oak", inSeason: true }
                        ]
                    },
                    {
                        code: "WEED",
                        displayName: "Weeds",
                        inSeason: false,
                        indexInfo: {
                            value: 0,
                            category: "None",
                            indexDescription: "No weed pollen detected."
                        }
                    }
                ]
            }
        ],
        bioSoilingAnalysis: {
            riskLevel: "MODERATE",
            stickinessFactor: "HIGH (Birch sap correlation)",
            cleaningRecommendation: "Schedule water-free brush cleaning within 7 days if rain does not occur."
        }
    };
};

export const queryMapsDatasets = async (args: any) => {
    // Simulating Google Maps Datasets API
    // Used to upload and query custom geospatial data (GeoJSON, KML)
    const datasetId = args.datasetId || "f47ac10b-58cc-4372-a567-0e02b2c3d479"; // UUID simulation
    
    return {
        source: "Google Maps Datasets API",
        dataset: {
            name: "Helios_Internal_Infrastructure_Layer",
            id: datasetId,
            state: "STATE_COMPLETED",
            usage: "DATASET_USAGE_MapsAPI",
            description: "High-voltage transmission lines and inverter substations for Arad/Livada.",
            createTime: "2024-03-15T10:00:00Z",
            updateTime: new Date().toISOString()
        },
        items: [
             { id: "feat_001", type: "Transmission_Line_HV", geometry: "MULTILINESTRING", properties: { voltage: "110kV", status: "Operational" } },
             { id: "feat_002", type: "Substation_Alpha", geometry: "POINT", properties: { capacity: "50MW", temp: "Normal" } },
             { id: "feat_003", type: "Solar_Block_B2", geometry: "POLYGON", properties: { panel_count: 4500, azimuth: 180 } }
        ],
        totalFeatureCount: 142
    };
};

export const fetchStreetView = async (args: any) => {
    return {
        source: "Street View Publish API",
        location: args.location,
        panoId: "CAoSLEFGMVFpcE...",
        captureDate: "2024-05-12",
        links: ["pano_next", "pano_prev"]
    };
};

export const testMapsGrounding = async (args: any) => {
    // Simulating Gemini 2.5 Flash with Google Maps Grounding
    // This feature connects the LLM directly to fresh Google Maps Place Data
    return {
        source: "Maps Grounding Lite",
        model: "gemini-2.5-flash",
        query: "solar energy providers in Romania",
        groundingMetadata: {
            groundingChunks: [
                {
                    maps: {
                        title: "Photon Energy Romania",
                        uri: "https://maps.google.com/?cid=1029384756",
                        address: "Bucharest, Romania"
                    }
                },
                {
                    maps: {
                        title: "Engie Romania Solar Division",
                        uri: "https://maps.google.com/?cid=5647382910",
                        address: "Bd. Marasesti, Bucharest"
                    }
                }
            ]
        }
    };
};

// --- SERVICE CLASS ---

export interface GeminiRequestConfig {
    isThinking?: boolean;
    isImageGen?: boolean;
    imageSize?: ImageSize;
    isImageEdit?: boolean;
    editContext?: { data: string, mimeType: string };
}

export class GeminiOrchestrator {
  private ai: GoogleGenAI;
  private history: any[] = [];
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.ai = new GoogleGenAI({ apiKey });
  }

  async executeSpecialTool(name: string, args: any, lastImageContext?: string): Promise<any> {
     try {
       // --- GOOGLE API SUITE (Specific Implementations) ---
       if (name === 'fetch_google_weather') return { result: await fetchGoogleWeather(args) };
       if (name === 'fetch_google_solar') return { result: await fetchGoogleSolar(args) };
       if (name === 'fetch_google_air_quality') return { result: await fetchGoogleAirQuality(args) };
       if (name === 'fetch_google_pollen') return { result: await fetchGooglePollen(args) };
       if (name === 'query_maps_datasets') return { result: await queryMapsDatasets(args) };
       if (name === 'fetch_street_view') return { result: await fetchStreetView(args) };

       // --- HELIOS CORE ---
       if (name === 'generate_technical_site_report') {
           const ai = new GoogleGenAI({ apiKey: this.apiKey });
           const reportResponse = await ai.models.generateContent({
               model: GEMINI_FLASH_MODEL_ID,
               contents: `Synthesize report for ${args.siteName}. Data: ${args.telemetrySummary}. Tone: ${args.tone}.`,
           });
           return { result: { report: reportResponse.text } };
       }
       if (name === 'fetch_planet_imagery') {
           const res = await fetchJson('/satellite/planet', {
               method: 'POST',
               headers: {'Content-Type': 'application/json'},
               body: JSON.stringify(args)
           });
           return { result: res };
       }
       if (name === 'execute_energy_trade') return { result: await fetchJson('/market/trade', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(args) }) };
       if (name === 'analyze_predictive_failure') return { result: await fetchJson('/analytics/failure-prediction', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(args) }) };
       if (name === 'plan_agrivoltaics') return { result: await fetchJson(`/geo/agrivoltaics?location=${args.location}&cropType=${args.cropType || ''}`) };
       if (name === 'searchPlaces') return { result: { places: await searchPlaces(args.query) } };
       if (name === 'searchSolarParks') return { result: { parks: searchParks(args.query) } };

     } catch (e: any) { return { error: e.message }; }
     return { error: "Unknown tool mapping" };
  }

  async sendMessage(
    text: string, 
    attachment?: Attachment, 
    onToolCall?: any, 
    lastImageContext?: string, 
    language: Language = 'ro', 
    preferredModel: string = DEFAULT_MODEL_ID,
    config: GeminiRequestConfig = {},
    onStreamUpdate?: (text: string) => void
  ): Promise<any> {
    
    let effectiveModelId = preferredModel;
    let effectiveConfig: any = {
        systemInstruction: language === 'ro' ? SYSTEM_INSTRUCTION_RO : SYSTEM_INSTRUCTION_EN,
    };

    if (attachment || config.isThinking) {
        effectiveModelId = GEMINI_PRO_MODEL_ID;
    }

    const lowerText = text.toLowerCase();
    const isMapQuery = lowerText.includes('harta') || lowerText.includes('map') || lowerText.includes('loca');
    
    if (isMapQuery && !attachment && !config.isThinking) {
        effectiveModelId = GEMINI_MAPS_MODEL_ID;
    }

    if (config.isThinking) {
        effectiveModelId = GEMINI_PRO_MODEL_ID;
        effectiveConfig.thinkingConfig = { thinkingBudget: 32768 };
        if (effectiveConfig.maxOutputTokens) delete effectiveConfig.maxOutputTokens;
    }

    // COMPLETE TOOL LIST INCLUDING GOOGLE APIs
    const standardTools = [
        fetchGoogleWeatherTool, fetchGoogleSolarTool, fetchGoogleAirQualityTool,
        fetchGooglePollenTool, queryMapsDatasetsTool, fetchStreetViewTool,
        generateSiteReportTool, fetchPlanetImageryTool, executeEnergyTradeTool,
        analyzePredictiveFailureTool, planAgrivoltaicsTool, searchPlacesTool, searchSolarParksTool
    ];

    if (effectiveModelId === GEMINI_MAPS_MODEL_ID) {
        effectiveConfig.tools = [{ googleMaps: {} }];
    } else if (effectiveModelId === GEMINI_FLASH_MODEL_ID || effectiveModelId === GEMINI_PRO_MODEL_ID) {
        effectiveConfig.tools = [
            { functionDeclarations: standardTools },
            { googleSearch: {} }
        ];
    } else {
        effectiveConfig.tools = [{ functionDeclarations: standardTools }];
    }

    const userParts: any[] = [{ text }];
    if (attachment) userParts.push({ inlineData: { mimeType: attachment.mimeType, data: attachment.data } });
    
    this.history.push({ role: 'user', parts: userParts });

    let finalGeneratedText = '';
    let finalExtractedImage: string | undefined = undefined;
    let finalGroundingSources: any[] = [];
    
    let keepGoing = true;
    while (keepGoing) {
        keepGoing = false;
        
        const stream = await withRetry(() => this.ai.models.generateContentStream({ 
            model: effectiveModelId, 
            contents: this.history, 
            config: effectiveConfig 
        })) as any;

        const rawPartsFromStream: any[] = [];

        for await (const chunk of stream) {
            let chunkText = '';
            const candidate = chunk.candidates?.[0];
            
            if (candidate?.content?.parts) {
                for (const part of candidate.content.parts) {
                    if (part.text) chunkText += part.text;
                }
            }

            if (chunkText) {
                finalGeneratedText += chunkText;
                if (onStreamUpdate) onStreamUpdate(finalGeneratedText);
            }
            
            if (candidate?.groundingMetadata?.groundingChunks) {
                const chunks = candidate.groundingMetadata.groundingChunks;
                chunks.forEach((chunk: any) => {
                    finalGroundingSources.push({
                         title: chunk.web?.title || chunk.maps?.title || "Grounding Source",
                         uri: chunk.web?.uri || chunk.maps?.uri,
                         type: chunk.web ? 'web' : 'map'
                    });
                });
            }

            if (candidate?.content?.parts) {
                rawPartsFromStream.push(...candidate.content.parts);
            }
        }

        const mergedParts: any[] = [];
        let currentTextPart: any = null;

        for (const part of rawPartsFromStream) {
            if (part.text && !part.thought) {
                if (currentTextPart) {
                    currentTextPart.text += part.text;
                } else {
                    currentTextPart = { text: part.text };
                    mergedParts.push(currentTextPart);
                }
            } else {
                currentTextPart = null; 
                mergedParts.push(part);
            }
        }

        this.history.push({ role: 'model', parts: mergedParts });

        const functionCalls = mergedParts.filter(p => p.functionCall).map(p => p.functionCall);

        if (functionCalls.length > 0) {
            const functionResponses = [];
            for (const fc of functionCalls) {
                if (onToolCall) onToolCall(fc.name, fc.args);
                
                const sr = await this.executeSpecialTool(fc.name, fc.args, lastImageContext);
                
                if (sr.result?.visualUrl) finalExtractedImage = sr.result.visualUrl;

                functionResponses.push({ 
                    functionResponse: { name: fc.name, response: { result: sr.result || { error: sr.error } } } 
                });
            }
            this.history.push({ role: 'user', parts: functionResponses });
            keepGoing = true;
            finalGeneratedText += "\n"; 
        }
    }

    return { 
      text: finalGeneratedText, 
      generatedImage: finalExtractedImage,
      groundingSources: finalGroundingSources
    };
  }
}
