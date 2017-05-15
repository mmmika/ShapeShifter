import * as $ from 'jquery';
import * as erd from 'element-resize-detector';
import * as _ from 'lodash';
import {
  Component, OnInit, ViewChild, AfterViewInit,
  OnDestroy, ElementRef, ChangeDetectionStrategy
} from '@angular/core';
import { MdSnackBar } from '@angular/material';
import { environment } from '../environments/environment';
import { Subscription } from 'rxjs/Subscription';
import { Observable } from 'rxjs/Observable';
import { CanvasType } from './CanvasType';
import { VectorLayer, PathLayer, LayerUtil } from './scripts/layers';
import { SvgLoader, VectorDrawableLoader } from './scripts/import';
import { SubPath } from './scripts/paths';
import {
  CanvasResizeService,
  SelectionService,
  AppModeService,
  AppMode,
  StateService,
  MorphStatus,
  FilePickerService,
  HoverService,
  ActionModeService,
  ShortcutService,
} from './services';
import { DemoUtil, DEMO_MAP, DEBUG_VECTOR_DRAWABLE } from './scripts/demos';
import 'rxjs/add/observable/combineLatest';
import {
  Store,
  State,
  AddLayers,
} from './store';

const IS_DEV_MODE = !environment.production;
const AUTO_LOAD_DEMO = IS_DEV_MODE && false;
const AUTO_LOAD_VECTOR_DRAWABLE = IS_DEV_MODE && false;
const ELEMENT_RESIZE_DETECTOR = erd();
const STORAGE_KEY_FIRST_TIME_USER = 'storage_key_first_time_user';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent implements OnInit, AfterViewInit, OnDestroy {
  readonly START_CANVAS = CanvasType.Start;
  readonly PREVIEW_CANVAS = CanvasType.Preview;
  readonly END_CANVAS = CanvasType.End;

  readonly CURSOR_DEFAULT = CursorType.Default;
  readonly CURSOR_POINTER = CursorType.Pointer;
  readonly CURSOR_PEN = CursorType.Pen;

  readonly SELECTION_MODE = AppMode.Selection;
  readonly SPLIT_COMMANDS_MODE = AppMode.SplitCommands;
  readonly SPLIT_SUBPATHS_MODE = AppMode.SplitSubPaths;
  readonly MORPH_SUBPATHS_MODE = AppMode.MorphSubPaths;

  readonly MORPH_NONE = MorphStatus.None;
  readonly MORPH_UNMORPHABLE = MorphStatus.Unmorphable;
  readonly MORPH_MORPHABLE = MorphStatus.Morphable;

  cursorObservable: Observable<CursorType>;
  statusTextObservable: Observable<string>;
  wasMorphable = false;

  private readonly subscriptions: Subscription[] = [];

  private canvasContainer: JQuery;
  private currentPaneWidth = 0;
  private currentPaneHeight = 0;

  private pendingFilePickerCanvasType: CanvasType;

  @ViewChild('canvasContainer') private canvasContainerRef: ElementRef;

  constructor(
    private readonly snackBar: MdSnackBar,
    private readonly filePickerService: FilePickerService,
    private readonly stateService: StateService,
    private readonly selectionService: SelectionService,
    private readonly hoverService: HoverService,
    private readonly canvasResizeService: CanvasResizeService,
    private readonly appModeService: AppModeService,
    private readonly actionModeService: ActionModeService,
    private readonly store: Store<State>,
    private readonly shortcutService: ShortcutService,
  ) { }

  ngOnInit() {
    // TODO: remove any unnecessary demo code here...
    if (AUTO_LOAD_DEMO) {
      this.autoLoadDemo();
    } else if (AUTO_LOAD_VECTOR_DRAWABLE) {
      const vl = VectorDrawableLoader.loadVectorLayerFromXmlString(DEBUG_VECTOR_DRAWABLE, []);
      this.store.dispatch(new AddLayers(vl));
    }

    this.cursorObservable =
      Observable.combineLatest(
        this.appModeService.asObservable(),
        this.hoverService.asObservable(),
      ).map(obj => {
        const [appMode, hover] = obj;
        if (appMode === AppMode.SplitCommands || appMode === AppMode.SplitSubPaths) {
          return CursorType.Pen;
        } else if (hover) {
          return CursorType.Pointer;
        }
        return CursorType.Default;
      });
    this.statusTextObservable =
      Observable.combineLatest(
        this.stateService.getMorphStatusObservable(),
        this.selectionService.asObservable(),
        this.appModeService.asObservable(),
      ).map(obj => {
        const status = obj[0];
        const startLayer = this.stateService.getActivePathLayer(CanvasType.Start);
        const endLayer = this.stateService.getActivePathLayer(CanvasType.End);
        if (!startLayer || !endLayer) {
          // TODO: show better user messaging when attempting to morph btw stroked and fill paths
          return '';
        }
        if (status === MorphStatus.Morphable) {
          const hasClosedPath =
            _.chain([CanvasType.Start, CanvasType.End])
              .map(type => this.stateService.getActivePathLayer(type).pathData)
              .flatMap(path => path.getSubPaths() as SubPath[])
              .some((subPath: SubPath) => subPath.isClosed() && !subPath.isCollapsing())
              .value();
          return `Reverse${hasClosedPath ? ', shift,' : ''} drag, or create `
            + `points above to customize the animation`;
        }
        if (status === MorphStatus.Unmorphable) {
          const startPath = startLayer.pathData;
          const endPath = endLayer.pathData;
          for (let i = 0; i < startPath.getSubPaths().length; i++) {
            const startCmds = startPath.getSubPath(i).getCommands();
            const endCmds = endPath.getSubPath(i).getCommands();
            if (startCmds.length !== endCmds.length) {
              const pathLetter = startCmds.length < endCmds.length ? 'a' : 'b';
              const diff = Math.abs(startCmds.length - endCmds.length);
              if (diff === 1) {
                return `Add 1 point to <i>subpath #${i + 1}${pathLetter}</i>`;
              } else {
                return `Add ${diff} points to <i>subpath #${i + 1}${pathLetter}</i>`;
              }
            }
          }
          // The user should never get to this point, but fallthrough just in case.
        }
        return '';
      });
    this.shortcutService.init();
    this.initBeforeOnLoadListener();

    this.subscriptions.push(
      this.filePickerService.asObservable()
        .subscribe(canvasType => this.addPathsFromSvg(canvasType)));
  }

  ngAfterViewInit() {
    this.canvasContainer = $(this.canvasContainerRef.nativeElement);
    const updateCanvasSizes = () => {
      // TODO: re-update this at some point...
      const numCanvases = 1;
      // const numCanvases = this.wasMorphable ? 3 : 2;
      const width = this.canvasContainer.width() / numCanvases;
      const height = this.canvasContainer.height();
      if (this.currentPaneWidth !== width || this.currentPaneHeight !== height) {
        this.currentPaneWidth = width;
        this.currentPaneHeight = height;
        this.canvasResizeService.setSize(width, height);
      }
    };

    this.subscriptions.push(
      this.stateService.getMorphStatusObservable().subscribe(status => {
        this.wasMorphable =
          status !== MorphStatus.None && (this.wasMorphable || status === MorphStatus.Morphable);
        updateCanvasSizes();
      }));

    ELEMENT_RESIZE_DETECTOR.listenTo(this.canvasContainer.get(0), el => {
      updateCanvasSizes();
    });

    if ('serviceWorker' in navigator) {
      const isFirstTimeUser = window.localStorage.getItem(STORAGE_KEY_FIRST_TIME_USER);
      if (!isFirstTimeUser) {
        window.localStorage.setItem(STORAGE_KEY_FIRST_TIME_USER, 'true');
        setTimeout(() => {
          this.snackBar.open('Ready to work offline', 'Dismiss', { duration: 5000 });
        });
      }
    }
  }

  ngOnDestroy() {
    ELEMENT_RESIZE_DETECTOR.removeAllListeners(this.canvasContainer.get(0));
    this.subscriptions.forEach(s => s.unsubscribe());
    this.shortcutService.destroy();
    $(window).unbind('beforeunload');
  }

  get morphStatus() {
    return this.stateService.getMorphStatus();
  }

  onCanvasContainerClick() {
    // TODO: is this hacky? should we be using onBlur() to reset the app mode?
    if (this.actionModeService.isShowingActionMode()) {
      this.actionModeService.closeActionMode();
    }
  }

  private initBeforeOnLoadListener() {
    // TODO: we should check to see if there are any dirty changes first
    $(window).on('beforeunload', event => {
      if (!IS_DEV_MODE
        && (this.stateService.getVectorLayer(CanvasType.Start)
          || this.stateService.getVectorLayer(CanvasType.End))) {
        return 'You\'ve made changes but haven\'t saved. ' +
          'Are you sure you want to navigate away?';
      }
      return undefined;
    });
  }

  // Called by the DropTargetDirective.
  onDropFiles(fileList: FileList) {
    // TODO: hook this up to svg/xml import...
  }

  // Proxies a button click to the <input> tag that opens the file picker.
  addPathsFromSvg(canvasType?: CanvasType) {
    // TODO: this doesnt work right now because the inputs are lazily initialized
    this.pendingFilePickerCanvasType = canvasType;
    $('#addPathsFromSvgButton').val('').click();
  }

  // Called when the user picks a file from the file picker.
  onSvgFilesPicked(fileList: FileList) {
    const pendingCanvasType = this.pendingFilePickerCanvasType;
    this.pendingFilePickerCanvasType = undefined;
    if (!fileList || !fileList.length) {
      console.warn('Failed to load SVG file');
      return;
    }

    const files: File[] = [];
    // tslint:disable-next-line
    for (let i = 0; i < fileList.length; i++) {
      files.push(fileList[i]);
    }

    let numCallbacks = 0;
    let numErrors = 0;
    const vls: VectorLayer[] = [];
    const maybeAddVectorLayersFn = () => {
      numCallbacks++;
      if (numErrors === files.length) {
        this.snackBar.open(
          `Couldn't import paths from SVG.`,
          'Dismiss',
          { duration: 5000 });
      } else if (numCallbacks === files.length) {
        const importedPathIds = LayerUtil.getAllIds(vls, l => l instanceof PathLayer);
        const numImportedPaths = importedPathIds.length;
        this.stateService.addVectorLayers(vls);
        const canvasTypesToCheck =
          pendingCanvasType === undefined
            ? [CanvasType.Start, CanvasType.End]
            : [pendingCanvasType];
        for (const canvasType of canvasTypesToCheck) {
          const activePathId = this.stateService.getActivePathId(canvasType);
          if (activePathId) {
            continue;
          }
          this.stateService.setActivePathId(canvasType, importedPathIds.shift());
        }
        this.snackBar.open(
          `Imported ${numImportedPaths} path${numImportedPaths === 1 ? '' : 's'}`,
          'Dismiss',
          { duration: 2750 });
      }
    };

    const currentIds = LayerUtil.getAllIds(this.stateService.getImportedVectorLayers());
    for (const file of files) {
      const fileReader = new FileReader();

      fileReader.onload = event => {
        const svgText = (event.target as any).result;
        SvgLoader.loadVectorLayerFromSvgStringWithCallback(svgText, vectorLayer => {
          if (!vectorLayer) {
            numErrors++;
            maybeAddVectorLayersFn();
            return;
          }
          vls.push(vectorLayer);
          currentIds.push(...LayerUtil.getAllIds([vectorLayer]));
          maybeAddVectorLayersFn();
        }, currentIds);
      };

      fileReader.onerror = event => {
        const target = event.target as any;
        switch (target.error.code) {
          case target.error.NOT_FOUND_ERR:
            alert('File not found');
            break;
          case target.error.NOT_READABLE_ERR:
            alert('File is not readable');
            break;
          case target.error.ABORT_ERR:
            break;
          default:
            alert('An error occurred reading this file');
        }
        numErrors++;
        maybeAddVectorLayersFn();
      };

      fileReader.onabort = event => {
        alert('File read cancelled');
      };

      fileReader.readAsText(file);
    }
  }

  // Proxies a button click to the <input> tag that opens the file picker.
  addPathsFromXml(canvasType?: CanvasType) {
    // TODO: this doesnt work right now because the inputs are lazily initialized
    $('#addPathsFromXmlButton').val('').click();
  }

  // Called when the user picks a file from the file picker.
  onXmlFilesPicked(fileList: FileList) {
    if (!fileList || !fileList.length) {
      console.warn('Failed to load XML file');
      return;
    }

    const files: File[] = [];
    // tslint:disable-next-line
    for (let i = 0; i < fileList.length; i++) {
      files.push(fileList[i]);
    }

    let numCallbacks = 0;
    let numErrors = 0;
    const vls: VectorLayer[] = [];
    const maybeAddVectorLayersFn = () => {
      numCallbacks++;
      if (numErrors === files.length) {
        this.snackBar.open(
          `Couldn't import the paths from XML.`,
          'Dismiss',
          { duration: 5000 });
      } else if (numCallbacks === files.length) {
        const importedPathIds = LayerUtil.getAllIds(vls, l => l instanceof PathLayer);
        const numImportedPaths = importedPathIds.length;
        this.stateService.addVectorLayers(vls);
        for (const canvasType of [CanvasType.Start, CanvasType.End]) {
          const activePathId = this.stateService.getActivePathId(canvasType);
          if (activePathId) {
            continue;
          }
          this.stateService.setActivePathId(canvasType, importedPathIds.shift());
        }
        this.snackBar.open(
          `Imported ${numImportedPaths} path${numImportedPaths === 1 ? '' : 's'}`,
          'Dismiss',
          { duration: 2750 });
      }
    };

    const currentIds = LayerUtil.getAllIds(this.stateService.getImportedVectorLayers());
    for (const file of files) {
      const fileReader = new FileReader();

      fileReader.onload = event => {
        const xmlText = (event.target as any).result;
        const vectorLayer = VectorDrawableLoader.loadVectorLayerFromXmlString(xmlText, currentIds);
        vls.push(vectorLayer);
        currentIds.push(...LayerUtil.getAllIds([vectorLayer]));
        maybeAddVectorLayersFn();
      };

      fileReader.onerror = event => {
        const target = event.target as any;
        switch (target.error.code) {
          case target.error.NOT_FOUND_ERR:
            alert('File not found');
            break;
          case target.error.NOT_READABLE_ERR:
            alert('File is not readable');
            break;
          case target.error.ABORT_ERR:
            break;
          default:
            alert('An error occurred reading this file');
        }
        numErrors++;
        maybeAddVectorLayersFn();
      };

      fileReader.onabort = event => {
        alert('File read cancelled');
      };

      fileReader.readAsText(file);
    }
  }

  private autoLoadDemo() {
    setTimeout(() => {
      DemoUtil.loadDemo(this.stateService, DEMO_MAP.get('Debug demos'));
    });
  }
}

enum CursorType {
  Default = 1,
  Pointer,
  Pen,
}
