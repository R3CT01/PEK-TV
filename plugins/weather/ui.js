// ============================================================
// StreamX Plugin — "Weather Widget" (Loop-Broken & Stable)
// ============================================================

window.app_name = 'Weather Widget';
window.app_version = '1.0.3';

window.render = function (engine) {
    const { createElement, ui } = engine;

    let unit = localStorage.getItem('streamx_weather_unit') || 'F';
    let currentCity = localStorage.getItem('streamx_weather_city') || 'St. Louis, MO';
    
    let weatherData = {
        city: currentCity,
        temp_c: 22,
        temp_f: 72,
        condition: 'Standard Cache'
    };

    const titleText = createElement('div', { style: 'font-size: 1.2rem; font-weight: 600; margin-bottom: 4px; color: var(--sx-text-primary, #fff);' }, 'Loading...');
    const subText = createElement('div', { style: 'font-size: 0.9rem; opacity: 0.7; color: var(--sx-text-secondary, #ccc);' }, 'Initializing weather data\u2026');

    const tempCard = createElement('div', {
        className: 'focusable',
        style: 'background: var(--sx-surface-alt, rgba(255,255,255,0.05)); padding: 16px; border-radius: 12px; border: 1px solid var(--sx-border, rgba(255,255,255,0.1)); cursor: pointer; transition: background 0.2s;',
        onClick: () => fetchWeatherCache()
    }, titleText, subText);

    const getWeatherDescription = (code) => {
        const codes = {
            0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
            45: 'Foggy', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Moderate drizzle',
            55: 'Dense drizzle', 61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
            71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow', 95: 'Thunderstorm'
        };
        return codes[code] || 'Clear';
    };

    const updateUI = () => {
        const tempC = parseFloat(weatherData.temp_c) || 22;
        const tempF = weatherData.temp_f !== undefined ? weatherData.temp_f : Math.round((tempC * 9/5) + 32);
        const tempStr = unit === 'F' ? `${tempF}\u00B0F` : `${Math.round(tempC)}\u00B0C`;
        
        titleText.textContent = tempStr;
        subText.textContent = `${weatherData.condition} \u2014 ${weatherData.city}`;

        // Algorithmic Upgrade: Conditional state check destroys the infinite re-render loop
        const previousTemp = localStorage.getItem('streamx_weather_current_temp');
        if (previousTemp !== tempStr) {
            localStorage.setItem('streamx_weather_current_temp', tempStr);
            window.dispatchEvent(new Event('storage'));
        }
    };

    const suggestionBox = createElement('div', {
        className: 'sx-suggestion-dropdown',
        style: 'position: absolute; top: 100%; left: 0; right: 0; background: var(--sx-surface); border: 1px solid var(--sx-border); border-radius: 8px; margin-top: 4px; z-index: 100; max-height: 160px; overflow-y: auto; display: none; box-shadow: 0 10px 25px rgba(0,0,0,0.5);'
    });

    const cityInput = createElement('input', {
        className: 'focusable sx-text-input',
        type: 'text',
        value: currentCity,
        placeholder: 'Type a city (e.g. St. Louis)\u2026',
        onInput: (e) => {
            const query = e.target.value;
            currentCity = query;
            if (query.length >= 2) {
                fetchCitySuggestions(query);
            } else {
                suggestionBox.style.display = 'none';
            }
        }
    });

    const cityInputWrap = createElement('div', { className: 'sx-field', style: 'position: relative;' },
        createElement('label', { className: 'sx-field-label' }, 'City Search & Disambiguation'),
        cityInput,
        suggestionBox
    );

    const fetchWithTimeout = async (url, timeoutMs = 3000) => {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeoutMs);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(id);
        return response;
    };

    async function fetchWeatherCache() {
        try {
            titleText.textContent = 'Updating...';
            const cacheBuster = Date.now();
            
            // Restored the absolute path structure so the Termux host can locate the file
            const res = await fetchWithTimeout(`/plugins/weather/weather.json?t=${cacheBuster}`, 2500);
            if (!res.ok) throw new Error('Failed to load local weather cache');
            
            const data = await res.json();
            weatherData = data;
            if (data.city) currentCity = data.city;
            cityInput.value = currentCity;
            
        } catch (err) {
            console.warn('[Weather Widget] Network halted; forcing fallback sequence:', err);
        } finally {
            updateUI();
        }
    }

    async function fetchCitySuggestions(query) {
        try {
            const res = await fetchWithTimeout(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=en&format=json`, 3000);
            const data = await res.json();
            
            suggestionBox.innerHTML = '';
            if (data && data.results && data.results.length > 0) {
                data.results.forEach(loc => {
                    const region = loc.admin1 ? `, ${loc.admin1}` : '';
                    const label = `${loc.name}${region} (${loc.country})`;
                    
                    const item = createElement('div', {
                        className: 'focusable',
                        style: 'padding: 10px 14px; cursor: pointer; border-bottom: 1px solid var(--sx-border); font-size: 0.9rem; color: var(--sx-text); transition: background 0.15s;',
                        onClick: () => {
                            cityInput.value = label;
                            currentCity = label;
                            localStorage.setItem('streamx_weather_city', label);
                            suggestionBox.style.display = 'none';
                            fetchLiveWeatherForCoords(loc.latitude, loc.longitude, label);
                        }
                    }, label);
                    suggestionBox.appendChild(item);
                });
                suggestionBox.style.display = 'block';
                engine.refreshFocusList();
            } else {
                suggestionBox.style.display = 'none';
            }
        } catch (err) {
            console.error('[Weather Widget] Autocomplete error:', err);
        }
    }

    async function fetchLiveWeatherForCoords(lat, lon, displayName) {
        titleText.textContent = 'Updating...';
        subText.textContent = `Fetching weather for ${displayName}\u2026`;

        try {
            const res = await fetchWithTimeout(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code`, 4000);
            if (!res.ok) throw new Error('API error');
            const data = await res.json();
            const current = data.current;
            const tempC = current.temperature_2m;
            
            weatherData = {
                city: displayName,
                temp_c: tempC,
                temp_f: Math.round((tempC * 9/5) + 32),
                condition: getWeatherDescription(current.weather_code)
            };
        } catch (err) {
            console.error('[Weather Widget] Live fetch error:', err);
        } finally {
            updateUI();
        }
    }

    const tabRow = ui.tabs(
        [{ id: 'F', label: 'Fahrenheit' }, { id: 'C', label: 'Celsius' }],
        unit,
        (id) => {
            unit = id;
            localStorage.setItem('streamx_weather_unit', id);
            updateUI();
        }
    );

    fetchWeatherCache();

    return createElement('div', {},
        tabRow,
        ui.grid([tempCard], { minColWidth: '180px' }),
        cityInputWrap
    );
};
