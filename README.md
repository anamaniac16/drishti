# DRISHTI (दृष्टि)

**AI mission planner for India's Earth-observation satellites.**

Every day, requests pile up for India's imaging satellites: a flood in Assam, a cyclone off
Odisha, crop surveys in Punjab, a landslide-prone slope in Uttarakhand. Each satellite passes
over India only a few times a day, can tilt only so far, has limited memory and power, and must
download its pictures when it flies over a ground station. On top of that, **clouds ruin a large
share of optical images**. A perfect schedule that photographs clouds is wasted.

DRISHTI builds that schedule for the next 48 hours, from live data, using three soft computing
techniques that each do a necessary job.

| Part | Technique | Job |
| --- | --- | --- |
| Cloud forecaster | **Artificial neural network** (MLP 12 → 20 → 10 → 1, backprop + Adam) | Learns from four weeks of past forecasts vs. what the sky actually did, then predicts the chance of a clear shot at the exact moment of each pass |
| Priority officer | **Fuzzy logic** (Mamdani, 5 inputs, 12 rules, centroid) | Scores every imaging opportunity from urgency, waiting time, clear-sky chance, look angle and sensor fit, the way a human planner would |
| Mission planner | **Genetic algorithm** (one gene per request, tournament selection, uniform crossover, mutation, elitism, Lamarckian repair) | Chooses which pass to use for each target under slew-time, memory and power limits. NP-hard: millions of possible schedules |

## Live data

| Source | Used for |
| --- | --- |
| [CelesTrak](https://celestrak.org) | Current orbital elements of Cartosat-3, Resourcesat-2A and EOS-04, propagated with SGP4 |
| [Open-Meteo](https://open-meteo.com) | Hourly cloud forecasts (low, mid, high), past forecasts and ERA5 observed cloud for training and checking |
| [NASA EONET](https://eonet.gsfc.nasa.gov) | Open natural events in the region (fires, storms, floods, volcanoes), added as urgent requests |
| [NASA GIBS](https://earthdata.nasa.gov/gibs) | Recent true-colour view of each target |

When a source can't be reached, the app says so in the top bar and switches to a built-in model
(approximate sun-synchronous orbits, a synthetic weather model), so it always runs.

## What you can do

- **📍 Click a place:** Click anywhere over India and its seas (or on a pin) and DRISHTI does
  the whole job for that one spot, step by step, so you can watch the AI work:
  1. **Clouds:** live hourly cloud forecast for that exact spot.
  2. **Routes:** propagates every satellite's orbit 48 hours ahead, finds every overflight and
     draws each pass's ground track on the globe.
  3. **Filter:** a funnel that strikes out passes one rule at a time, with the reason on each:
     too steep for the camera, in the dark, likely cloudy (neural network), not worth a shot
     (fuzzy priority), or the satellite is busy with something more valuable. The best pass of
     each satellite becomes a shot, and the panel explains why the winner won (fuzzy inputs and
     the rules that fired).
  4. **Capture:** the satellites fly the chosen passes and take the pictures.
  5. **Check:** a fuzzy cloud mask scans every picture pixel by pixel (bright AND grey = cloud,
     colourful = ground, white on a clear day too = snow, not cloud) and rejects cloudy ones.
  6. **Deliver:** the best picture is sent down at the satellite's next ground-station contact,
     with the time from click to picture.
- **Plan:** See every request on a 3D globe and every pass on a 48-hour timeline. Plan it yourself
  by clicking passes, then press **AI plan** and watch the genetic algorithm evolve a better one.
- **Add requests:** Pick a type and urgency, click anywhere over India, and it gets fitted into the plan.
- **Switch parts of the AI off:** Turn off the neural network, fuzzy logic or the genetic search
  and re-plan, to see what each one contributes.
- **Fly:** Run the day. Satellites move along their real orbits, photograph targets, and downlink
  to NRSC Shadnagar and Bharati station in Antarctica.
- **Past day:** Replay a day from last week. Plans are made from that day's forecast, then scored
  against the clouds that **actually** happened (ERA5), so the result is measured, not estimated.
- **Brain:** See the neural network's test accuracy against the raw forecast, its training curve
  and predictions, edit fuzzy membership functions, switch rules on and off, and see exactly which
  rules fired for any shot.

## Scoreboard

Every plan is compared with two baselines:

- **First come, first served:** Oldest request first, earliest pass, ignores clouds.
- **Greedy:** Each request's single best pass, one at a time.

## Running it

Open `index.html` through any static server (live data needs a real web origin):

```bash
python -m http.server 8000
# open http://localhost:8000
```

Headless planning test (Node, built-in data):

```bash
node tools/plan-test.js
```

## Files

```
index.html           layout
css/style.css        styles
js/core.js           orbits, access windows, neural network, fuzzy system, genetic algorithm
js/live.js           live data with timeouts and fallbacks
js/globe.js          Three.js globe, satellites, ground stations, pins
js/app.js            app logic, timeline, scoreboard, brain view
js/mission.js        click a place: routes, filter funnel, capture, fuzzy cloud mask, delivery
js/geo-data.js       coastlines and borders (Natural Earth 1:50m)
tools/plan-test.js   headless run of a full planning day
```

## Satellites modelled

| Satellite | Sensor | Max tilt | Notes |
| --- | --- | --- | --- |
| Cartosat-3 | optical, 0.25 m | 40° | agile, fast slewing |
| Resourcesat-2A | optical, 5.8 m | 26° | slower to slew |
| EOS-04 | C-band radar | 35° | sees through cloud and works at night |

Satellite agility, memory and power limits are simplified, illustrative values.

---

Anamika Dutta · B.Tech CSE (Data Science), Amity School of Engineering & Technology
