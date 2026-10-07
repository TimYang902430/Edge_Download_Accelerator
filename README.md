# \# Download Accelerator 

# Splits files into chunks and downloads them in parallel to saturate bandwidth. Edge / Chrome MV3 extension.





# \## Install

# 1\. Open `edge://extensions` and turn on \*\*Developer mode\*\* . 

# 2\. Click \*\*Load unpacked\*\* and select this folder. 

# 3\. In the extension's \*\*Details\*\* , set \*\*Site access\*\* to \*\*On all sites\*\* — otherwise requests fail with `Failed to fetch` .

# 4\. To download `file://` local files, also enable \*\*Allow access to file URLs\*\* . 





# \## Usage 

# \- Click the toolbar icon to open the manager page; or right-click a link → \*\*Download this link with Download Accelerator\*\* ; right-click the page → \*\*Download this page's URL with Download Accelerator\*\* . 

# \- Paste links in the manager (separated by spaces / commas / newlines, or drag links in) → \*\*Add and start\*\* . 

# \- Recommended first step: \*\*Choose save folder\*\* and grant access. Chunks stream straight to disk, resumable, no size limit. Without it the extension falls back to in-memory concatenation — 2 GB cap, and everything is lost when the page closes.

# &#x20;



# \## Settings

# &#x20;| Setting | Default | Notes |

# |---|---|---|

# | Mode | Auto | Starts at the 16-thread ceiling right away. Turn off to use a fixed thread count |

# | Threads | 4 | Concurrency in fixed mode, 1–32 |

# | Simultaneous downloads | 1 | Parallel tasks, 1–5; tasks compete for bandwidth |

# | Follow login state | On | Send cookies with requests | 





# \## How it works

# \- Splits the file into chunks aligned to 64 KB via `Range` ; chunk count is always ≥ thread count so no worker idles. 

# \- All threads pull from a shared cursor: whoever finishes grabs the next chunk, so a slow chunk never pins a thread. 

# \- Writes are serialized: the file is preallocated, then written at offsets, avoiding concurrent-write conflicts. 

# \- Failed chunks retry 3 times with exponential backoff from 500 ms; any missing bytes are filled in during the final pass. 

# \- Checkpoints live in IndexedDB — close and reopen the manager page to resume. 





# \## Limitations 

# \- Server has no `Range` support, or the file is under 2 MB → falls back to a single connection, never slower. 

# \- Browsers won't open extra TCP connections to the same origin; if a site rate-limits per client, more threads won't help. 

# \- `http(s)` links only. 





# \## Layout manifest.json

# &#x20;   icons/              icons

# &#x20;   src/background.js   context menus, open/focus the manager page

# &#x20;   src/manager.html    manager page

# &#x20;   src/manager.css

# &#x20;   src/manager.js      task queue and rendering

# &#x20;   src/lib/engine.js   probing, chunked concurrency, adaptive threads, retry and resume

# &#x20;   src/lib/sink.js     FsaSink (serialized write queue) / BlobSink (in-memory fallback)

# &#x20;   src/lib/store.js    settings, directory handle, checkpoints

# &#x20;   src/lib/format.js   byte / speed / duration formatting

