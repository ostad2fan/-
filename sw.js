const CACHE_NAME = 'anbar-cache-v4';
const urlsToCache = [
  // Local app shell
  '/',
  '/index.html',
  '/index.tsx',
  '/index.css',
  '/production.html',
  '/outsourcing.html',
  '/wip_report.html',
  '/workshop_costs.html',
  '/calculator.html',
  '/bom.html',
  '/manifest.json',
  '/branding.json',
  '/logo.png',

  // Core external scripts
  'https://cdn.tailwindcss.com',
  'https://cdn.sheetjs.com/xlsx-0.20.2/package/dist/xlsx.full.min.js',
  'https://unpkg.com/@babel/standalone@7.24.8/babel.min.js',

  // Fonts (the CSS file)
  'https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;700&display=swap',
  'https://fonts.googleapis.com/css2?family=Vazirmatn:wght@300;400;500;600;700&display=swap',
  
  // Icon
  'https://www.gstatic.com/images/branding/product/1x/drive_2020q4_48dp.png',

  // Main esm.sh modules from import maps. Others will be cached on-the-fly.
  'https://esm.sh/react@18.3.1',
  'https://esm.sh/react-dom@18.3.1/client',
  'https://esm.sh/react@18.3.1/jsx-runtime', // Very common dependency for JSX
  'https://esm.sh/@google/genai@^1.9.0',
  'https://esm.sh/jspdf@^3.0.1',
  'https://esm.sh/jspdf-autotable@^5.0.2'
];

self.addEventListener('install', (event) => {
  // Perform install steps
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Opened cache for precaching local and external assets');
        return cache.addAll(urlsToCache).catch(err => {
            console.error('Failed to cache all URLs:', urlsToCache, err);
        });
      })
  );
});

self.addEventListener('fetch', (event) => {
  // We only handle GET requests
  if (event.request.method !== 'GET') {
    return;
  }
  
  // For external resources like fonts from Google, use a cache-first strategy
  // but always try to update in the background for freshness (stale-while-revalidate).
  if (event.request.url.startsWith('https://fonts.gstatic.com')) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => {
        return cache.match(event.request).then((cachedResponse) => {
          const fetchedResponse = fetch(event.request).then((networkResponse) => {
            cache.put(event.request, networkResponse.clone());
            return networkResponse;
          });
          return cachedResponse || fetchedResponse;
        });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        // Cache hit - return response
        if (response) {
          return response;
        }

        // Not in cache, try to fetch from network.
        // This is important for API calls which should not be cached by this logic.
        return fetch(event.request).then(
          (response) => {
            // Check if we received a valid response and it's not an API call
            // We don't want to cache API responses in this generic cache.
            if (!response || response.status !== 200 || event.request.url.includes('/api/')) {
              return response;
            }

            // IMPORTANT: Clone the response. A response is a stream
            // and because we want the browser to consume the response
            // as well as the cache consuming the response, we need
            // to clone it so we have two streams.
            const responseToCache = response.clone();
            caches.open(CACHE_NAME)
              .then((cache) => {
                cache.put(event.request, responseToCache);
              });

            return response;
          }
        ).catch(() => {
            // If the network request fails, and we didn't have it in cache,
            // it means the user is offline and we don't have this resource.
            // You could return a fallback page here if you have one.
            // For now, we just let the fetch fail.
        });
      })
  );
});

self.addEventListener('activate', (event) => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
