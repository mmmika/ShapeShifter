import { Point } from '../common';
import { SvgChar } from '.';
import { CommandBuilder } from './CommandImpl';

/**
 * Defines the set of SVG command methods that are seen by the inspector/canvas.
 */
export interface Command {

  /**
   * Returns true iff the command was created as a result of being split.
   * Only split commands are able to be editted and deleted via the inspector/canvas.
   */
  isSplit(): boolean;

  /**
   * Returns the unique ID for this command.
   */
  getId(): string;

  /**
   * Returns the SVG character for this command.
   */
  getSvgChar(): SvgChar;

  /**
   * Returns the points for this command.
   */
  getPoints(): ReadonlyArray<Point>;

  /**
   * Returns the command's starting point.
   */
  getStart(): Point;

  /**
   * Returns the command's ending point.
   */
  getEnd(): Point;

  /**
   * Returns true iff this command can be converted into a new command
   * that is morphable with the specified SVG command type.
   */
  canConvertTo(ch: SvgChar): boolean;

  /**
   * Returns a builder to construct a mutated Command.
   */
  mutate(): CommandBuilder;
}

/**
 * Uniquely identifies a command's location in an SVG.
 */
export interface Index {
  readonly pathId: string;
  readonly subIdx: number;
  readonly cmdIdx: number;
}
