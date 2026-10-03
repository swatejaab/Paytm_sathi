import { useEffect, useState } from 'react';

export type Page = 'home' | 'saathi' | 'insights' | 'goals' | 'more';
export interface Route {
  page: Page;
  param: string | null;
}

const PAGES: Page[] = ['home', 'saathi', 'insights', 'goals', 'more'];

export function parseRoute(hash: string): Route {
  const [first, second] = hash.replace(/^#\/?/, '').split('/');
  const page = PAGES.includes(first as Page) ? (first as Page) : 'home';
  return { page, param: second ? decodeURIComponent(second) : null };
}

export const routeHref = (page: Page, param?: string | null): string =>
  page === 'home' ? '#/' : `#/${page}${param ? `/${encodeURIComponent(param)}` : ''}`;

export function navigate(page: Page, param?: string | null, options: { replace?: boolean } = {}): void {
  const href = routeHref(page, param);
  if (window.location.hash === href) return;
  if (options.replace) window.history.replaceState(null, '', href);
  else window.history.pushState(null, '', href);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', update);
    window.addEventListener('popstate', update);
    return () => {
      window.removeEventListener('hashchange', update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return route;
}
