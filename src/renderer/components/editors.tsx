import { reaction } from 'mobx';
import { observer } from 'mobx-react';
import * as MonacoType from 'monaco-editor';
import * as React from 'react';
import { Mosaic, MosaicNode, MosaicWindow, MosaicWindowProps } from 'react-mosaic-component';

import { EditorId } from '../../interfaces';
import { IpcEvents } from '../../ipc-events';
import { updateEditorLayout } from '../../utils/editor-layout';
import { getFocusedEditor } from '../../utils/focused-editor';
import { getAtPath, setAtPath } from '../../utils/js-path';
import { toggleMonaco } from '../../utils/toggle-monaco';
import { getContent } from '../content';
import { ipcRendererManager } from '../ipc';
import { AppState } from '../state';
import { activateTheme } from '../themes';
import { Editor } from './editor';
import { renderNonIdealState } from './editors-non-ideal-state';
import { MaximizeButton, RemoveButton } from './editors-toolbar-button';

const defaultMonacoOptions: MonacoType.editor.IEditorOptions = {
  minimap: {
    enabled: false
  },
  wordWrap: 'on'
};

const ViewIdMosaic = Mosaic.ofType<EditorId>() as any;
const ViewIdMosaicWindow = MosaicWindow.ofType<EditorId>() as any;

export const TITLE_MAP: Record<EditorId, string> = {
  main: 'Main Process',
  renderer: 'Renderer Process',
  html: 'HTML'
};

export interface EditorsProps {
  appState: AppState;
}

export interface EditorsState {
  monaco?: typeof MonacoType;
  isMounted?: boolean;
  monacoOptions: MonacoType.editor.IEditorOptions;
}

@observer
export class Editors extends React.Component<EditorsProps, EditorsState> {
  // A reaction: Each time mosaicArrangement is changed, we'll update
  // the editor layout. That method is itself debounced.
  public disposeLayoutAutorun = reaction(
    () => this.props.appState.mosaicArrangement,
    () => updateEditorLayout()
  );

  constructor(props: EditorsProps) {
    super(props);

    this.onChange = this.onChange.bind(this);

    this.state = { monacoOptions: defaultMonacoOptions };

    this.loadMonaco();
  }

  /**
   * Executed right after the component mounts. We'll setup the IPC listeners here.
   *
   * @memberof Editors
   */
  public componentDidMount() {
    ipcRendererManager.on(IpcEvents.MONACO_EXECUTE_COMMAND, (_event, cmd: string) => {
      this.executeCommand(cmd);
    });

    ipcRendererManager.on(IpcEvents.FS_NEW_FIDDLE, async (_event) => {
      const { version } = this.props.appState;

      this.props.appState.setWarningDialogTexts({
        label: 'Your current fiddle is unsaved. Do you want to discard it?'
      });

      window.ElectronFiddle.app.setValues({
        html: await getContent(EditorId.html, version),
        renderer: await getContent(EditorId.renderer, version),
        main: await getContent(EditorId.main, version),
      });
    });

    ipcRendererManager.on(IpcEvents.MONACO_TOGGLE_OPTION, (_event, cmd: string) => {
      this.toggleEditorOption(cmd);
    });

    this.setState({ isMounted: true });
  }

  public componentWillUnmount() {
    this.disposeLayoutAutorun();
  }

  /**
   * Attempt to execute a given commandId on the currently focused editor
   *
   * @param {string} commandId
   * @memberof Editors
   */
  public executeCommand(commandId: string) {
    const editor = getFocusedEditor();

    if (editor) {
      const command = editor.getAction(commandId);

      console.log(`Editors: Trying to run ${command.id}. Supported: ${command.isSupported}`);

      if (command && command.isSupported()) {
        command.run();
      }
    }
  }

  public toggleEditorOption(path: string): boolean {
    if (!window.ElectronFiddle.editors) {
      return false;
    }

    try {
      const { monacoOptions } = this.state;
      const newOptions = { ...monacoOptions };
      const currentSetting = getAtPath(path, newOptions);

      setAtPath(path, newOptions, toggleMonaco(currentSetting));

      Object.keys(window.ElectronFiddle.editors)
        .forEach((key) => {
          const editor: MonacoType.editor.IStandaloneCodeEditor | null
            = window.ElectronFiddle.editors[key];

          if (editor) {
            editor.updateOptions(newOptions);
          }
        });

      this.setState({ monacoOptions: newOptions });

      return true;
    } catch (error) {
      console.warn(`Editors: Could not toggle property ${path}`, error);

      return false;
    }
  }

  /**
   * Renders the little tool bar on top of editors
   *
   * @param {MosaicWindowProps<EditorId>} { title }
   * @param {EditorId} id
   * @returns {JSX.Element}
   */
  public renderToolbar({ title }: MosaicWindowProps<EditorId>, id: EditorId): JSX.Element {
    return (
      <div>
        {/* Left */}
        <div>
          <h5>
            {title}
          </h5>
        </div>
        {/* Middle */}
        <div />
        {/* Right */}
        <div className='mosaic-controls'>
          <MaximizeButton id={id} appState={this.props.appState} />
          <RemoveButton id={id} appState={this.props.appState} />
        </div>
      </div>
    );
  }

  public render() {
    const { appState } = this.props;
    const { monaco } = this.state;

    if (!monaco) return null;

    return (
      <ViewIdMosaic
        onChange={this.onChange}
        value={appState.mosaicArrangement}
        zeroStateView={renderNonIdealState(appState)}
        // tslint:disable-next-line:jsx-no-multiline-js
        renderTile={(id: any, path: any) => (
          <ViewIdMosaicWindow
            className={id}
            path={path}
            title={TITLE_MAP[id]}
            renderToolbar={(props: MosaicWindowProps<EditorId>) => this.renderToolbar(props, id)}
          >
            <Editor
              id={id}
              monaco={monaco}
              appState={appState}
              monoacoOptions={defaultMonacoOptions}
            />
          </ViewIdMosaicWindow>
        )}
      />
    );
  }

  /**
   * Handles a change in the visible nodes
   *
   * @param {(MosaicNode<EditorId> | null)} currentNode
   */
  public onChange(currentNode: MosaicNode<EditorId> | null) {
    this.props.appState.mosaicArrangement = currentNode;
  }

  /**
   * Loads monaco. If it's already loaded, it'll just set it on the current state.
   * We're doing things a bit roundabout to ensure that we're not overloading the
   * mobx state with a gigantic Monaco tree.
   */
  public async loadMonaco(): Promise<void> {
    const { app } = window.ElectronFiddle;
    const loader = require('monaco-loader');
    const monaco = app.monaco || await loader();

    if (!app.monaco) {
      app.monaco = monaco;
    }

    if (!this.state || !this.state.isMounted) {
      this.state = {
        monaco,
        monacoOptions: defaultMonacoOptions
      };
    } else {
      this.setState({ monaco });
    }

    activateTheme(monaco, undefined, this.props.appState.theme);
  }
}
