
import IBMi from './IBMi';
import { SimpleQueue } from './queue';
import { Tools } from './Tools';
import { CommandResult, ILELibrarySettings, RemoteCommand, StandardIO } from './types';
import { Variables } from './variables';

export namespace CompileTools {
  export const NEWLINE = `\r\n`;
  export const DID_NOT_RUN = -123;
  const HIDE_MESSAGE_IDS = [`CPF3485`, `SQL0462`];

  // The SQL job lives as long as the connection, so its job log keeps growing.
  // QSYS2.JOBLOG_INFO reads the whole job log on every call, and it is called after every
  // command, so commands get slower over time. Past this many messages the job log is trimmed.
  const JOBLOG_TRIM_THRESHOLD = 1000;

  const ileQueue = new SimpleQueue();

  let jobLogOrdinal = 0;
  let jobLogTrimFailed = false;

  interface RunCommandEvents {
    writeEvent?: (content: string) => void
    commandConfirm?: (command: string) => Promise<string>
    updateProgress?: (message: string) => void
  }

  export function reset() {
    ileQueue.clear();
    jobLogOrdinal = 0;
    jobLogTrimFailed = false;
  }

  /**
   * Execute a command
   */
  export async function runCommand(connection: IBMi, options: RemoteCommand, events: RunCommandEvents = {}): Promise<CommandResult> {
    const config = connection.getConfig();
    if (config && connection) {
      const cwd = options.cwd;
      const variables = new Variables(connection, options.env);

      const currentLibrary = variables.get(`&CURLIB`) || config.currentLibrary || "";

      const ileSetup: ILELibrarySettings = {
        currentLibrary: (/\*CURLIB/i.test(currentLibrary) ? "" : currentLibrary),
        libraryList: (variables.get(`&LIBL`)?.split(` `) || config.libraryList).filter(Tools.distinct),
      };

      const libraryList = buildLibraryList(ileSetup);
      variables.set(`&LIBLS`, libraryList.join(` `));

      let commandString = variables.expand(options.command);

      if (events.commandConfirm) {
        events.updateProgress?.(" - Prompting...");
        commandString = await events.commandConfirm(commandString);
        events.updateProgress?.("");
      }

      if (commandString) {
        const commands = commandString.split(`\n`).filter(command => command.trim().length > 0);

        if (events.writeEvent) {
          if (options.environment === `ile` && !options.noLibList) {
            events.writeEvent(`Current library: ` + (ileSetup.currentLibrary || "no current library") + NEWLINE);
            events.writeEvent(`Library list: ` + ileSetup.libraryList.join(` `) + NEWLINE);
          }
          if (options.cwd) {
            events.writeEvent(`Working directory: ` + options.cwd + NEWLINE);
          }
          events.writeEvent(`Commands:\n${commands.map(command => `\t${command}\n`).join(``)}` + NEWLINE);
        }

        const callbacks: StandardIO = events.writeEvent ? {
          onStdout: (data) => {
            events.writeEvent!(data.toString().replaceAll(`\n`, NEWLINE));
          },
          onStderr: (data) => {
            events.writeEvent!(data.toString().replaceAll(`\n`, NEWLINE));
          }
        } : {};

        let commandResult: CommandResult;
        switch (options.environment) {
          case `pase`:
            commandResult = await connection.sendCommand({
              command: commands.join(` && `),
              directory: cwd,
              env: variables.toPaseVariables(),
              ...callbacks
            });
            break;

          case `qsh`:
            commandResult = await connection.sendQsh({
              command: [
                ...options.noLibList ? [] : buildLiblistCommands(connection, ileSetup),
                ...commands,
              ].join(` && `),
              directory: cwd,
              ...callbacks
            });
            break;

          case `ile`:
          default:
            commandResult = {
              code: 0,
              stderr: ``,
              stdout: ``,
              command: commands.join(`, `),
            };

            await ileQueue.next(async () => {
              const start = options.getSpooledFiles ? (await connection.runSQL('Values Current TimeStamp'))[0]["00001"] : undefined;
              try {
                await connection.runSQL([
                  ...(cwd ? [`@QSYS/CHGCURDIR DIR('${cwd}')`] : []),
                  ...(options.noLibList ? [] : [`@QSYS/CHGLIBL CURLIB(${ileSetup.currentLibrary || "*CRTDFT"}) LIBL(${ileSetup.libraryList.join(` `)})`]),
                  ...commands.map(c => `@${c}`)
                ]);
              } catch (e: any) {
                commandResult.stdout = e.message;
                commandResult.code = 1;
              }

              // Then fetch the job log
              try {
                // We only care about messages since the last run :)
                const lastJobLog = await connection.runSQL(`select ORDINAL_POSITION, message_id, message_text from table(qsys2.joblog_info('*')) where ordinal_position > ${jobLogOrdinal}`);
                if (lastJobLog?.length) {
                  commandResult.stderr = lastJobLog
                    .filter(r => !HIDE_MESSAGE_IDS.includes(r.MESSAGE_ID as string))
                    .map(r => `${r.MESSAGE_ID}: ${r.MESSAGE_TEXT}`).join(`\n`);
                  callbacks.onStderr?.(Buffer.from(commandResult.stderr));
                  jobLogOrdinal = Number(lastJobLog[lastJobLog.length - 1].ORDINAL_POSITION);
                } else {
                  jobLogOrdinal = 0; // Reset if no job log
                }
              } catch (e) {
                commandResult.code = 3;
              }

              // Fetch the spooled files if requested
              if (start) {
                try {
                  const spooledOutputs: string[] = [];
                  const spooledFiles = await connection.runSQL(`SELECT QUALIFIED_JOB_NAME, SPOOLED_FILE_NAME,	SPOOLED_FILE_NUMBER FROM TABLE(QSYS2.SPOOLED_FILE_INFO(STARTING_TIMESTAMP => '${start}', USER_DATA => '${connection.splfUserData}', STATUS => '*HELD'))`);
                  for (const spooledFile of spooledFiles) {
                    spooledOutputs.push((await connection.runSQL(`SELECT spooled_data as LINE FROM TABLE(systools.spooled_file_data(
                        job_name => '${spooledFile.QUALIFIED_JOB_NAME}',
                        spooled_file_name => '${spooledFile.SPOOLED_FILE_NAME}', 
                        spooled_file_number => ${spooledFile.SPOOLED_FILE_NUMBER})
                      )`)).map(row => String(row.LINE).trimEnd()).join("\n"));
                  }
                  commandResult.stdout = spooledOutputs.join("\n\n");
                  callbacks.onStdout?.(Buffer.from(commandResult.stdout));
                } catch (e) {
                  commandResult.code = 2;
                  callbacks.onStderr?.(Buffer.from(`Failed to get spool output: ${JSON.stringify(e, undefined, 2)}`));
                }
              }
              if (!start || !connection.getConfig().keepActionSpooledFiles) {
                await connection.runSQL(`@QSYS/DLTSPLF FILE(*SELECT) SELECT(*CURRENT *ALL *ALL ${connection.splfUserData})`);
              }

              if (jobLogOrdinal > JOBLOG_TRIM_THRESHOLD && !jobLogTrimFailed) {
                await trimJobLog(connection);
              }
            });

            break;
        }

        commandResult.command = commandString;
        return commandResult;

      } else {
        return {
          code: DID_NOT_RUN,
          command: options.command,
          stdout: ``,
          stderr: `Command execution failed. (No command)`,
        };
      }
    }
    else {
      throw new Error("Please connect to an IBM i");
    }
  }

  /**
   * Removes the messages of the ended call stack entries from the SQL job's job log,
   * then realigns the job log position on what is left.
   */
  async function trimJobLog(connection: IBMi) {
    try {
      // RMVMSG is not allowed through QCMDEXC (CPD0031), so the QMHRMVPM API is called directly:
      // call stack entry *ALLINACT, counter 0, blank message key, remove *ALL, error code 0
      await connection.runSQL(`@QSYS/CALL PGM(QSYS/QMHRMVPM) PARM('*ALLINACT' X'00000000' '    ' '*ALL' X'00000000')`);
    } catch (e) {
      // Trimming is only an optimisation: if it fails, do not try again on every command
      jobLogTrimFailed = true;
    }

    try {
      const [row] = await connection.runSQL(`select count(*) as MESSAGES from table(qsys2.joblog_info('*'))`);
      jobLogOrdinal = Number(row?.MESSAGES) || 0;
    } catch (e) {
      // Keep the current position
    }
  }

  function buildLibraryList(config: ILELibrarySettings): string[] {
    //We have to reverse it because `liblist -a` adds the next item to the top always 
    return config.libraryList.slice(0).reverse();
  }

  function buildLiblistCommands(connection: IBMi, config: ILELibrarySettings): string[] {
    return [
      `liblist -d ${IBMi.escapeForShell(Tools.sanitizeObjNamesForPase(...connection.defaultUserLibraries).join(` `))}`,
      `liblist -c ${IBMi.escapeForShell(Tools.sanitizeObjNamesForPase(config.currentLibrary || "*CRTDFT")[0])}`,
      `liblist -a ${IBMi.escapeForShell(Tools.sanitizeObjNamesForPase(...buildLibraryList(config)).join(` `))}`
    ];
  }
}