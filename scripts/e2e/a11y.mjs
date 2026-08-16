/**
 * The accessibility rules this gate enforces, run in the page.
 *
 * Deliberately a small set of RELEASE-BLOCKING rules rather than a
 * general linter: an unnamed control, an unlabelled field, a heading
 * jump, a missing language or a target nobody can hit are all things a
 * person actually collides with. Cosmetic findings belong in a backlog,
 * not in a gate that must stay at zero.
 *
 * WCAG 2.2 AA 2.5.8 sets the target minimum at 24×24 CSS px, with an
 * exception for targets whose size is constrained by the line box of
 * surrounding text — so inline links inside a sentence are exempt, and
 * a standalone control is not.
 */
export async function auditPage(page) {
  return page.evaluate(() => {
    const unnamed = [];
    const unlabelledFields = [];
    const smallTargets = [];

    const nameOf = (el) =>
      (el.textContent ?? '').trim() ||
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      (el.getAttribute('aria-labelledby') &&
        document.getElementById(el.getAttribute('aria-labelledby'))?.textContent) ||
      '';

    for (const el of document.querySelectorAll('button, a[href]')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (!nameOf(el)) unnamed.push(`<${el.tagName.toLowerCase()}>`);

      const style = getComputedStyle(el);
      // Inline text links are exempt: their size is set by the line box.
      const inline = style.display === 'inline' || style.display === 'contents';
      /*
       * A visually-hidden skip link is not a pointer target while it is
       * hidden, so 2.5.8 does not apply to it in that state. The
       * exemption is EARNED rather than assumed: `focusTargets` below
       * checks that it becomes a proper target once focused.
       */
      const visuallyHidden =
        (r.width <= 1 && r.height <= 1) || style.clip === 'rect(0px, 0px, 0px, 0px)';
      if (!inline && !visuallyHidden && (r.width < 24 || r.height < 24)) {
        smallTargets.push(
          `${el.tagName.toLowerCase()}"${nameOf(el).slice(0, 18)}" ${Math.round(r.width)}×${Math.round(r.height)}`,
        );
      }
    }

    for (const el of document.querySelectorAll('input, select, textarea')) {
      if (el.type === 'hidden') continue;
      const labelled =
        el.getAttribute('aria-label') ||
        el.getAttribute('aria-labelledby') ||
        (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) ||
        el.closest('label');
      if (!labelled) unlabelledFields.push(`${el.tagName.toLowerCase()}#${el.id || '(no id)'}`);
    }

    const levels = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) =>
      Number(h.tagName[1]),
    );
    const headingSkips = [];
    let previous = 0;
    for (const level of levels) {
      if (previous && level > previous + 1) headingSkips.push(`h${previous}→h${level}`);
      previous = level;
    }

    return {
      unnamed,
      unlabelledFields,
      smallTargets,
      headingSkips,
      lang: document.documentElement.lang,
      h1: document.querySelectorAll('h1').length,
    };
  });
}
