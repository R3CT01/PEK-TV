import os
import json
import urllib.request

def get_weather_desc(code):
    codes = {
        0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
        45: 'Foggy', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Moderate drizzle',
        55: 'Dense drizzle', 61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
        71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow', 95: 'Thunderstorm'
    }
    return codes.get(code, 'Clear')

def run():
    print("[Weather Plugin] backend.py is running and fetching weather via Open-Meteo...")
    city = "St. Louis, MO"
    lat = 38.62727
    lon = -90.19789
    
    url = f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m,weather_code"
    
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'StreamX-Weather-Plugin'})
        with urllib.request.urlopen(req, timeout=5) as response:
            data = json.loads(response.read().decode('utf-8'))
            current = data.get('current', {})
            temp_c = current.get('temperature_2m', 22)
            weather_code = current.get('weather_code', 0)
            desc = get_weather_desc(weather_code)
            
            temp_f = round((temp_c * 9/5) + 32)
            
            weather_payload = {
                "city": city,
                "temp_c": temp_c,
                "temp_f": temp_f,
                "condition": desc
            }
            
            plugin_dir = os.path.dirname(os.path.abspath(__file__))
            json_path = os.path.join(plugin_dir, 'weather.json')
            with open(json_path, 'w') as f:
                json.dump(weather_payload, f)
            print(f"[Weather Plugin] Successfully updated weather.json: {temp_f}°F ({desc})")
            
    except Exception as e:
        print(f"[Weather Plugin] Error fetching weather: {e}")
        plugin_dir = os.path.dirname(os.path.abspath(__file__))
        json_path = os.path.join(plugin_dir, 'weather.json')
        fallback = {"city": city, "temp_c": 22, "temp_f": 72, "condition": "Standard Cache"}
        with open(json_path, 'w') as f:
            json.dump(fallback, f)
