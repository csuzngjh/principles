import type { Flame } from "lucide-react";

export interface NavItem {
  id: string;
  label: string;
  icon: typeof Flame;
  href: string;
  alsoActive?: string[];
}

export function isNavActive(href: string, pathname: string, alsoActive?: string[]): boolean {
  if (href === "/") return pathname === "/";
  if (alsoActive && alsoActive.some(alt => alt === pathname)) return true;
  return pathname === href || pathname.startsWith(href + "/");
}
