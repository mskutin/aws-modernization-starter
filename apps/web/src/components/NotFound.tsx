import { HOME_HREF } from '../routing';

export function NotFound() {
  return (
    <section className="card" aria-labelledby="not-found-heading">
      <h2 id="not-found-heading">Page not found</h2>
      <p>There is nothing at this address.</p>
      <p>
        <a href={HOME_HREF}>Back to jobs</a>
      </p>
    </section>
  );
}
