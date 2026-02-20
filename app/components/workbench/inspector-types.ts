import type { BoxModelData } from './BoxModelEditor';

export interface ElementSummary {
  tagName: string;
  id: string;
  classes: string[];
  selector: string;
  displayText: string;
  hasChildren: boolean;
}

export interface ElementHierarchy {
  parents: ElementSummary[];
  current: ElementSummary | null;
  children: ElementSummary[];
  siblings: ElementSummary[];
  totalChildren: number;
  totalSiblings: number;
}

export interface ElementInfo {
  displayText: string;
  tagName: string;
  className: string;
  id: string;
  textContent: string;
  styles: Record<string, string>;
  boxModel?: BoxModelData;
  selector?: string;
  hierarchy?: ElementHierarchy;
  colors?: string[];
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    left: number;
  };
}
