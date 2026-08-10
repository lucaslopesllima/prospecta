import { useEffect, useState } from 'react';
import { TileLayer } from 'react-leaflet';

// O mapa vive em DOM próprio do Leaflet. Observar a classe no <html> mantém os
// tiles sincronizados inclusive quando o tema segue o sistema operacional.
export function ThemedTileLayer(): React.JSX.Element {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return (
    <TileLayer key={dark ? 'dark' : 'light'} attribution="&copy; OpenStreetMap"
      className={dark ? 'leaflet-dark-tiles' : undefined}
      url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
  );
}
