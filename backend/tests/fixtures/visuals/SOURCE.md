# Test images for the real-engine G3 test (M4 UI-B)

Genuinely public-domain images from Wikimedia Commons, used by
`tests/integration/test_real_engine.py::test_g3_success_with_genuinely_licensed_images`.
Each was downloaded on 2026-11-27 as the 960-pixel rendering Commons serves for the file
(`thumb.wikimedia.org`), so the bytes are a scaled copy of the original. The licence and
author below are what the file page and the Commons API (`extmetadata`) reported that day.

| File here | Commons file page | Uploaded | Licence | Author / credit |
|---|---|---|---|---|
| `earth-apollo17.jpg` (960×961, SHA-256 `16eaa544…fae80a`) | https://commons.wikimedia.org/wiki/File:The_Earth_seen_from_Apollo_17.jpg | 2020-09-25 | Public domain (NASA work) | NASA / Apollo 17 crew (taken by Harrison Schmitt or Ron Evans) |
| `us-constitution-page1.jpg` (960×1162, SHA-256 `a3830c00…e7e95a`) | https://commons.wikimedia.org/wiki/File:Constitution_of_the_United_States_-_DPLA_-_9ca804144bd5965e992ae3528bc3c6a3_(page_1).jpg | 2016-11-03 | Public domain | Constitutional Convention (1787); scan via the Digital Public Library of America |
| `global-temperature-anomaly.png` (960×667, SHA-256 `dad28bc1…85e036f`) | https://commons.wikimedia.org/wiki/File:Global_Temperature_Anomaly.svg | 2026-06-29 (current version) | Public domain (NASA work) | NASA Goddard Institute for Space Studies (data: https://data.giss.nasa.gov/gistemp/graphs_v4/); PNG rendering of the SVG by Commons |

Public domain needs no attribution; the test still records creator, source URL and licence
with each import, as a reviewer would.
