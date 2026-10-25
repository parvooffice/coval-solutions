export const fmt = (value) => new Intl.NumberFormat("en-US").format(Number(value) || 0);
