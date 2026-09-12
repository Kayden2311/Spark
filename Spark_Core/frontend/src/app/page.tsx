import Link from "next/link";

export default function HomePage() {
  return (
    <main className="shell">
      <header className="siteHeader">
        <Link className="brand" href="/" aria-label="Spark home">
          Spark
        </Link>
        <nav aria-label="Main navigation">
          <a className="textLink" href="#communities">
            Communities
          </a>
        </nav>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <p className="eyebrow">Where startups find their community</p>
        <h1 id="hero-title">Find your people. Build together.</h1>
        <p className="lede">
          Discover communities by industry, stage, and location, then create a
          workspace for your team.
        </p>
        <div className="search" role="search" aria-label="Search communities">
          <label htmlFor="community-query">What community are you looking for?</label>
          <div className="searchRow">
            <input
              id="community-query"
              name="q"
              type="search"
              placeholder="Example: technology startups in Hanoi"
              autoComplete="off"
              disabled
            />
            <button type="button" disabled>
              Coming soon
            </button>
          </div>
          <p className="featureNote">
            Search will be available when the communities API is ready.
          </p>
        </div>
      </section>

      <section id="communities" className="notice" aria-labelledby="notice-title">
        <h2 id="notice-title">Spark is taking shape</h2>
        <p>The community directory will appear here when its API is ready.</p>
      </section>
    </main>
  );
}
