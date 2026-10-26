export default function Brand({ onClick }) {
  return (
    <a className="brand" href="#overview" aria-label="COVAL Solutions home" onClick={onClick}>
      <span className="brand-mark" aria-hidden="true">
        <img className="brand-logo-light" src="/coval-logo-light.png" alt="" width="38" height="38" />
        <img className="brand-logo-dark" src="/coval-logo-dark.png" alt="" width="38" height="38" />
      </span>
      <span className="brand-text">
        <strong className="brand-name">COVAL</strong>
        <small className="brand-desc">SOLUTIONS</small>
      </span>
    </a>
  );
}
