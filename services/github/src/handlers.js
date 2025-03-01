const Debug = require('debug');
const taskcluster = require('taskcluster-client');
const libUrls = require('taskcluster-lib-urls');
const yaml = require('js-yaml');
const assert = require('assert');
const {consume} = require('taskcluster-lib-pulse');

const debugPrefix = 'taskcluster-github:handlers';
const debug = Debug(debugPrefix);

const CONCLUSIONS = { // maps status communicated by the queue service to github checkrun conclusions
  /*eslint-disable quote-props*/
  'completed': 'success',
  'failed': 'failure',
  'exception': 'failure',
  'deadline-exceeded': 'timed_out',
  'canceled': 'cancelled',
  'superseded': 'neutral', // queue status means: is not relevant anymore
  'claim-expired': 'failure',
  'worker-shutdown': 'neutral', // queue status means: will be retried
  'malformed-payload': 'action_required', // github status means "correct your task definition"
  'resource-unavailable': 'failure',
  'internal-error': 'failure',
  'intermittent-task': 'neutral', // queue status means: will be retried
};

/**
 * Create handlers
 */
class Handlers {
  constructor(options) {
    debug('Constructing handlers...');
    const {
      rootUrl,
      credentials,
      monitor,
      reference,
      jobQueueName,
      deprecatedResultStatusQueueName,
      deprecatedInitialStatusQueueName,
      resultStatusQueueName,
      initialStatusQueueName,
      intree,
      context,
      pulseClient,
    } = options;

    assert(monitor, 'monitor is required for statistics');
    assert(reference, 'reference must be provided');
    assert(rootUrl, 'rootUrl must be provided');
    assert(intree, 'intree configuration builder must be provided');
    this.rootUrl = rootUrl;
    this.credentials = credentials;
    this.monitor = monitor;
    this.reference = reference;
    this.intree = intree;
    this.connection = null;
    this.deprecatedResultStatusQueueName = deprecatedResultStatusQueueName;
    this.resultStatusQueueName = resultStatusQueueName;
    this.jobQueueName = jobQueueName;
    this.deprecatedInitialStatusQueueName = deprecatedInitialStatusQueueName;
    this.initialStatusQueueName = initialStatusQueueName;
    this.context = context;
    this.pulseClient = pulseClient;

    this.handlerComplete = null;
    this.handlerRejected = null;

    this.jobPq = null;
    this.resultStatusPq = null;
    this.deprecatedResultStatusPq = null;
    this.initialTaskStatusPq = null;
    this.deprecatedInitialStatusPq = null;

    this.queueClient = null;
  }

  /**
   * Set up the handlers.
   */
  async setup(options = {}) {
    debug('Setting up handlers...');
    assert(!this.jobPq, 'Cannot setup twice!');
    assert(!this.resultStatusPq, 'Cannot setup twice!');
    assert(!this.initialTaskStatusPq, 'Cannot setup twice!');
    assert(!this.deprecatedResultStatusPq, 'Cannot setup twice!');
    assert(!this.deprecatedInitialStatusPq, 'Cannot setup twice!');

    // This is a simple Queue client without scopes to use throughout the handlers for simple things
    // Where scopes are needed, use this.queueClient.use({authorizedScopes: scopes}).blahblah
    // (see this.createTasks for example)
    this.queueClient = new taskcluster.Queue({
      rootUrl: this.context.cfg.taskcluster.rootUrl,
    });

    // Listen for new jobs created via the api webhook endpoint
    const GithubEvents = taskcluster.createClient(this.reference);
    const githubEvents = new GithubEvents({rootUrl: this.rootUrl});
    const jobBindings = [
      githubEvents.pullRequest(),
      githubEvents.push(),
      githubEvents.release(),
    ];

    const schedulerId = this.context.cfg.taskcluster.schedulerId;
    const queueEvents = new taskcluster.QueueEvents({rootUrl: this.rootUrl});

    const statusBindings = [
      queueEvents.taskFailed(`route.${this.context.cfg.app.checkTaskRoute}`),
      queueEvents.taskException(`route.${this.context.cfg.app.checkTaskRoute}`),
      queueEvents.taskCompleted(`route.${this.context.cfg.app.checkTaskRoute}`),
    ];

    // Listen for state changes to the taskcluster tasks and taskgroups
    // We only need to listen for failure and exception events on
    // tasks. We wait for the entire group to be resolved before checking
    // for success.
    const deprecatedResultStatusBindings = [
      queueEvents.taskFailed(`route.${this.context.cfg.app.statusTaskRoute}`),
      queueEvents.taskException(`route.${this.context.cfg.app.statusTaskRoute}`),
      queueEvents.taskGroupResolved({schedulerId}),
    ];

    // Listen for taskGroupCreationRequested event to create initial status on github
    const deprecatedInitialStatusBindings = [
      githubEvents.taskGroupCreationRequested(`route.${this.context.cfg.app.statusTaskRoute}`),
    ];

    // Listen for taskDefined event to create initial status on github
    const taskBindings = [
      queueEvents.taskDefined(`route.${this.context.cfg.app.checkTaskRoute}`),
    ];

    const callHandler = (name, handler) => message => {
      handler.call(this, message).catch(async err => {
        await this.monitor.reportError(err);
        return err;
      }).then((err=null) => {
        if (this.handlerComplete && !err) {
          this.handlerComplete();
        } else if (this.handlerRejected && err) {
          this.handlerRejected(err);
        }
      });
    };

    this.jobPq = await consume(
      {
        client: this.pulseClient,
        bindings: jobBindings,
        queueName: this.jobQueueName,
      },
      this.monitor.timedHandler('joblistener', callHandler('job', jobHandler).bind(this))
    );

    this.deprecatedResultStatusPq = await consume(
      {
        client: this.pulseClient,
        bindings: deprecatedResultStatusBindings,
        queueName: this.deprecatedResultStatusQueueName,
      },
      this.monitor.timedHandler('deprecatedStatuslistener', callHandler('status', deprecatedStatusHandler).bind(this))
    );

    this.deprecatedInitialStatusPq = await consume(
      {
        client: this.pulseClient,
        bindings: deprecatedInitialStatusBindings,
        queueName: this.deprecatedInitialStatusQueueName,
      },
      this.monitor.timedHandler('deprecatedlistener', callHandler('task', taskGroupCreationHandler).bind(this))
    );

    this.resultStatusPq = await consume(
      {
        client: this.pulseClient,
        bindings: statusBindings,
        queueName: this.resultStatusQueueName,
      },
      this.monitor.timedHandler('statuslistener', callHandler('status', statusHandler).bind(this))
    );

    this.initialTaskStatusPq = await consume(
      {
        client: this.pulseClient,
        bindings: taskBindings,
        queueName: this.initialStatusQueueName,
      },
      this.monitor.timedHandler('tasklistener', callHandler('task', taskDefinedHandler).bind(this))
    );

  }

  async terminate() {
    debug('Terminating handlers...');
    if (this.jobPq) {
      await this.jobPq.stop();
    }
    if (this.resultStatusPq) {
      await this.resultStatusPq.stop();
    }
    if (this.initialTaskStatusPq) {
      await this.initialTaskStatusPq.stop();
    }
    if (this.deprecatedResultStatusPq) {
      await this.deprecatedResultStatusPq.stop();
    }
    if (this.deprecatedInitialStatusPq) {
      await this.deprecatedInitialStatusPq.stop();
    }
  }

  // Create a collection of tasks, centralized here to enable testing without creating tasks.
  async createTasks({scopes, tasks}) {
    const scopedQueueClient = this.queueClient.use({
      authorizedScopes: scopes,
      credentials: this.context.cfg.taskcluster.credentials,
    });
    for (const t of tasks) {
      await scopedQueueClient.createTask(t.taskId, t.task);
    }
  }

  // Send an exception to Github in the form of a comment.
  async createExceptionComment({instGithub, organization, repository, sha, error, pullNumber}) {
    let errorBody = error.body && error.body.error || error.message;
    // Let's prettify any objects
    if (typeof errorBody === 'object') {
      errorBody = JSON.stringify(errorBody, null, 4);
    }
    let body = [
      '<details>\n',
      '<summary>Submitting the task to Taskcluster failed. Details</summary>',
      '',
      errorBody, // already in Markdown..
      '',
      '</details>',
    ].join('\n') ;

    // Warn the user know that there was a problem handling their request
    // by posting a comment; this error is then considered handled and not
    // reported to the taskcluster team or retried
    if (pullNumber) {
      debug(`creating exception comment on ${organization}/${repository}#${pullNumber}`);
      await instGithub.issues.createComment({
        owner: organization,
        repo: repository,
        number: pullNumber,
        body,
      });
      return;
    }
    debug(`creating exception comment on ${organization}/${repository}@${sha}`);
    await instGithub.repos.createCommitComment({
      owner: organization,
      repo: repository,
      sha,
      body,
    });
  }

  /**
   * Function that examines the yml and decides which policy we're using. Defining policy in the yml is not required
   * by the schema, so if it's not defined, the function returns default policy.
   *
   * @param taskclusterYml - parsed YML (JSON object, see docs on `.taskcluster.yml`)
   * @returns policy, a string (either "collaborator" or "public" - available values at the moment)
   */
  getRepoPolicy(taskclusterYml) {
    const DEFAULT_POLICY = 'collaborators';

    if (taskclusterYml.version === 0) {
      // consult its `allowPullRequests` field
      return taskclusterYml.allowPullRequests || DEFAULT_POLICY;
    } else if (taskclusterYml.version === 1) {
      if (taskclusterYml.policy) {
        return taskclusterYml.policy.pullRequests || DEFAULT_POLICY;
      }
    }

    return DEFAULT_POLICY;
  }

  /**
   * Try to get `.taskcluster.yml` from a certain ref.
   *
   * @param instGithub - authenticated installation object
   * @param owner - org or a user, a string
   * @param repo - repository, a string
   * @param ref - SHA or branch/tag name, a string
   *
   * @returns either parsed YML if there's a YML and it was parsed successfully,
   * or null if there's no YML,
   * or throws an error in other cases
   */
  async getYml({instGithub, owner, repo, ref}) {
    let response;
    try {
      response = await instGithub.repos.getContents({owner, repo, path: '.taskcluster.yml', ref});
    } catch (e) {
      if (e.status === 404) {
        debug(`${owner}/${repo} has no '.taskcluster.yml' at ${ref}. Skipping.`);
        return null;
      }

      if (e.message.endsWith('</body>\n</html>\n') && e.message.length > 10000) {
        // We kept getting full html 500/400 pages from github in the logs.
        // I consider this to be a hard-to-fix bug in octokat, so let's make
        // the logs usable for now and try to fix this later. It's a relatively
        // rare occurence.
        debug('Detected an extremely long error. Truncating!');
        e.message = e.message.slice(0, 100).concat('...');
        e.stack = e.stack.split('</body>\n</html>\n')[1] || e.stack;
      }
      debug(`Error fetching yaml for ${owner}/${repo}@${ref}: ${e.message} \n ${e.stack}`);
      throw e;
    }

    return yaml.safeLoad(Buffer.from(response.data.content, 'base64').toString());
  }
}
module.exports = Handlers;

/**
 * Post updates to GitHub, when the status of a task changes. Uses Statuses API
 * Taskcluster States: https://docs.taskcluster.net/reference/platform/queue/references/events
 * GitHub Statuses: https://developer.github.com/v3/repos/statuses/
 **/
async function deprecatedStatusHandler(message) {
  let taskGroupId = message.payload.taskGroupId || message.payload.status.taskGroupId;

  let build = await this.context.Builds.load({
    taskGroupId,
  });

  let debug = Debug(`${debugPrefix}:deprecated-result-handler:${build.eventId}`);
  debug(`Statuses API. Handling state change for task-group ${taskGroupId}`);

  let state = 'success';

  if (message.exchange.endsWith('task-group-resolved')) {
    let params = {};
    do {
      let group = await this.queueClient.listTaskGroup(message.payload.taskGroupId, params);
      params.continuationToken = group.continuationToken;

      for (let i = 0; i < group.tasks.length; i++) {
        // don't post group status for checks API
        if (group.tasks[i].task.routes.includes(this.context.cfg.app.checkTaskRoute)) {
          debug(`Task group result status not updated: Task group ${taskGroupId} uses Checks API. Exiting`);
          return;
        }

        if (['failed', 'exception'].includes(group.tasks[i].status.state)) {
          state = 'failure';
          break; // one failure is enough
        }
      }

    } while (params.continuationToken && state === 'success');
  }

  if (message.exchange.endsWith('task-exception') || message.exchange.endsWith('task-failed')) {
    state = 'failure';
  }

  await build.modify(b => {
    if (b.state !== 'failure') {
      b.state = state;
      b.updated = new Date();
    }
  });
  if (build.state !== state) {
    debug('Task group already marked as failure. Continuing.');
    return;
  }

  let instGithub;
  // Authenticating as installation.
  try {
    debug('Authenticating as installation in status handler...');
    instGithub = await this.context.github.getInstallationGithub(build.installationId);
    debug('Authorized as installation in status handler');
  } catch (e) {
    debug(`Error authenticating as installation in status handler! Error: ${e}`);
    throw e;
  }

  debug(`Attempting to update status for ${build.organization}/${build.repository}@${build.sha} (${state})`);
  const target_url = libUrls.ui(this.context.cfg.taskcluster.rootUrl, `/task-group-inspector/#/${taskGroupId}`);
  try {
    await instGithub.repos.createStatus({
      owner: build.organization,
      repo: build.repository,
      sha: build.sha,
      state,
      target_url,
      description: 'TaskGroup: ' + state,
      context: `${this.context.cfg.app.statusContext} (${build.eventType.split('.')[0]})`,
    });
  } catch (e) {
    debug(`Failed to update status: ${build.organization}/${build.repository}@${build.sha}`);
    throw e;
  }
}

/**
 * Post updates to GitHub, when the status of a task changes. Uses Checks API
 **/
async function statusHandler(message) {
  let {taskGroupId, state, runs, taskId} = message.payload.status;
  let {runId} = message.payload;
  let {reasonResolved} = runs[runId];

  let conclusion = CONCLUSIONS[reasonResolved || state];

  let build = await this.context.Builds.load({
    taskGroupId,
  });

  let {organization, repository, sha, eventId, eventType, installationId} = build;

  let debug = Debug(`${debugPrefix}:${eventId}`);
  debug(`Handling state change for task ${taskId} in group ${taskGroupId}`);

  let taskState = {
    status: 'completed',
    conclusion: conclusion || 'neutral',
    completed_at: new Date().toISOString(),
  };

  if (conclusion === undefined) {
    this.monitor.reportError(new Error(`Unknown reasonResolved or state in ${message.exchange}!
      Resolution reason received: ${reasonResolved}. State received: ${state}. Add these to the handlers map.
      TaskId: ${taskId}, taskGroupId: ${taskGroupId}`)
    );

    taskState.output = {
      summary: `Message came with unknown resolution reason or state. 
        Resolution reason received: ${reasonResolved}. State received: ${state}. The status has been marked as neutral. 
        For further information, please inspect the task in Taskcluster`,
      title: 'Unknown Resolution',
    };
  }

  // true means we'll get null if the record doesn't exist
  let checkRun = await this.context.CheckRuns.load({taskGroupId, taskId}, true);

  let instGithub;
  // Authenticating as installation.
  try {
    debug('Authenticating as installation in status handler...');
    instGithub = await this.context.github.getInstallationGithub(installationId);
    debug('Authorized as installation in status handler');
  } catch (e) {
    debug(`Error authenticating as installation in status handler! Error: ${e}`);
    throw e;
  }

  debug(
    `Attempting to update status of the checkrun for ${organization}/${repository}@${sha} (${taskState.conclusion})`
  );
  try {
    if (checkRun) {
      await instGithub.checks.update({
        ...taskState,
        owner: organization,
        repo: repository,
        check_run_id: checkRun.checkRunId,
      });
    } else {
      const taskDefinition = await this.queueClient.task(taskId);
      debug(`Result status. Got task build from DB and task definition for ${taskId} from Queue service`);

      const checkRun = await instGithub.checks.create({
        owner: organization,
        repo: repository,
        name: `${taskDefinition.metadata.name}`,
        head_sha: sha,
        output: {
          title: `${this.context.cfg.app.statusContext} (${eventType.split('.')[0]})`,
          summary: `${taskDefinition.metadata.description}`,
          text: `[Task group](${libUrls.ui(this.context.cfg.taskcluster.rootUrl, `/groups/${taskGroupId}`)})`,
        },
        details_url: libUrls.ui(
          this.context.cfg.taskcluster.rootUrl,
          `/groups/${taskGroupId}/tasks/${taskId}/details`
        ),
      });

      await this.context.CheckRuns.create({
        taskGroupId: taskGroupId,
        taskId: taskId,
        checkSuiteId: checkRun.data.check_suite.id.toString(),
        checkRunId: checkRun.data.id.toString(),
      });

      await this.context.ChecksToTasks.create({
        taskGroupId,
        taskId,
        checkSuiteId: checkRun.data.check_suite.id.toString(),
        checkRunId: checkRun.data.id.toString(),
      });
    }
  } catch (e) {
    debug(`Failed to update status: ${build.organization}/${build.repository}@${build.sha}`);
    throw e;
  }
}

/**
 * If a .taskcluster.yml exists, attempt to turn it into a taskcluster
 * graph config, and post the initial status on github.
 **/
async function jobHandler(message) {
  let debug = Debug(debugPrefix + ':' + message.payload.eventId);
  debug('Received message. Starting processing...');
  let context = this.context;

  // Authenticating as installation.
  let instGithub = await context.github.getInstallationGithub(message.payload.installationId);

  // We must attempt to convert the sanitized fields back to normal here.
  // Further discussion of how to deal with this cleanly is in
  // https://github.com/taskcluster/taskcluster-github/issues/52
  message.payload.organization = message.payload.organization.replace(/%/g, '.');
  message.payload.repository = message.payload.repository.replace(/%/g, '.');
  let organization = message.payload.organization;
  let repository = message.payload.repository;
  let sha = message.payload.details['event.head.sha'];
  let pullNumber = message.payload.details['event.pullNumber'];
  if (!sha) {
    debug('Trying to get commit info in job handler...');
    let commitInfo = await instGithub.repos.getCommitRefSha({
      owner: organization,
      repo: repository,
      ref: `refs/tags/${message.payload.details['event.version']}`,
    });
    sha = commitInfo.data.sha;
  }

  debug(`handling ${message.payload.details['event.type']} webhook for: ${organization}/${repository}@${sha}`);

  // Try to fetch a .taskcluster.yml file for every request
  debug(`Trying to fetch the YML for ${organization}/${repository}@${sha}`);
  let repoconf;
  try {
    repoconf = await this.getYml({instGithub, owner: organization, repo: repository, ref: sha});
  } catch (e) {
    if (e.name === 'YAMLException') {
      return await this.createExceptionComment({
        instGithub,
        organization,
        repository,
        sha,
        error: e,
        pullNumber,
      });
    }
    debug(`Error checking yaml for ${organization}/${repository}@${sha}: ${e}`);
    throw e;
  }
  if (!repoconf) { return; }

  let groupState = 'pending';
  let taskGroupId = 'nonexistent';
  let graphConfig;

  // Now we can try processing the config and kicking off a task.
  try {
    graphConfig = this.intree({
      config: repoconf,
      payload: message.payload,
      validator: context.validator,
      schema: {
        0: libUrls.schema(this.rootUrl, 'github', 'v1/taskcluster-github-config.yml'),
        1: libUrls.schema(this.rootUrl, 'github', 'v1/taskcluster-github-config.v1.yml'),
      },
    });
    if (graphConfig.tasks !== undefined && !Array.isArray(graphConfig.tasks)) {
      throw new Error('tasks field  of .taskcluster.yml must be array of tasks or empty array');
    }
    if (!graphConfig.tasks || graphConfig.tasks.length === 0) {
      debug(`intree config for ${organization}/${repository}@${sha} compiled with zero tasks. Skipping.`);
      return;
    }
  } catch (e) {
    debug(`.taskcluster.yml for ${organization}/${repository}@${sha} was not formatted correctly. 
      Leaving comment on Github.`);
    await this.createExceptionComment({instGithub, organization, repository, sha, error: e, pullNumber});
    return;
  }

  // Checking pull request permission.
  if (message.payload.details['event.type'].startsWith('pull_request.')) {
    debug(`Checking pull request permission for ${organization}/${repository}@${sha}...`);

    debug(`Retrieving  ${organization}/${repository}@${sha}...`);
    let defaultBranch = (await instGithub.repos.get({owner: organization, repo: repository}))
      .data
      .default_branch;

    let defaultBranchYml = await this.getYml({instGithub, owner: organization, repo: repository, ref: defaultBranch});

    if (!defaultBranchYml) { return; }

    if (this.getRepoPolicy(defaultBranchYml).startsWith('collaborators')) {
      let login = message.payload.details['event.head.user.login'];

      let isCollaborator = await instGithub.repos.checkCollaborator({
        owner: organization,
        repo: repository,
        username: login,
      }).catch(e => {
        if (e.status !== 404) {
          throw e;
        }
      });

      if (!isCollaborator) {
        if (message.payload.details['event.type'].startsWith('pull_request.opened') && (this.getRepoPolicy(defaultBranchYml) !== 'collaborators_quiet')) {
          let body = [
            '<details>\n',
            '<summary>No Taskcluster jobs started for this pull request</summary>\n\n',
            '```js\n',
            'The `allowPullRequests` configuration for this repository (in `.taskcluster.yml` on the',
            'default branch) does not allow starting tasks for this pull request.',
            '```\n',
            '</details>',
          ].join('\n');
          await instGithub.issues.createComment({
            owner: organization,
            repo: repository,
            number: pullNumber,
            body,
          });
        }

        debug(`This user is not collaborator on ${organization}/${repository} and can't make PR@${sha}. Exiting...`);
        return;
      }
    }
  }

  taskGroupId = graphConfig.tasks[0].task.taskGroupId;
  let {routes} = graphConfig.tasks[0].task;

  try {
    debug(`Trying to create a record for ${organization}/${repository}@${sha} (${groupState}) in Builds table`);
    let now = new Date();
    await context.Builds.create({
      organization,
      repository,
      sha,
      taskGroupId,
      state: groupState,
      created: now,
      updated: now,
      installationId: message.payload.installationId,
      eventType: message.payload.details['event.type'],
      eventId: message.payload.eventId,
    });
  } catch (err) {
    if (err.code !== 'EntityAlreadyExists') {
      throw err;
    }
    let build = await this.Builds.load({
      taskGroupId,
    });
    assert.equal(build.state, groupState, `State for ${organization}/${repository}@${sha}
      already exists but is set to ${build.state} instead of ${groupState}!`);
    assert.equal(build.organization, organization);
    assert.equal(build.repository, repository);
    assert.equal(build.sha, sha);
    assert.equal(build.eventType, message.payload.details['event.type']);
    assert.equal(build.eventId, message.payload.eventId);
  }

  try {
    debug(`Creating tasks for ${organization}/${repository}@${sha} (taskGroupId: ${taskGroupId})`);
    await this.createTasks({scopes: graphConfig.scopes, tasks: graphConfig.tasks});
  } catch (e) {
    debug(`Creating tasks for ${organization}/${repository}@${sha} failed! Leaving comment on Github.`);
    return await this.createExceptionComment({instGithub, organization, repository, sha, error: e});
  }

  try {
    debug(`Publishing status exchange for ${organization}/${repository}@${sha} (${groupState})`);
    await context.publisher.taskGroupCreationRequested({
      taskGroupId,
      organization,
      repository,
    }, routes);
  } catch (e) {
    debug(`Failed to publish to taskGroupCreationRequested exchange. 
    Parameters: ${taskGroupId}, ${organization}, ${repository}, ${routes}`);
    debug(`Stack: ${e.stack}`);
    return debug(`Failed to publish to taskGroupCreationRequested exchange 
    for ${organization}/${repository}@${sha} with the error: ${JSON.stringify(e, null, 2)}`);
  }

  debug(`Job handling for ${organization}/${repository}@${sha} completed.`);

}

/**
 * When the task group was defined, post the initial status to github
 * statuses api function
 *
 * @param message - taskGroupCreationRequested exchange message
 *   this repo/schemas/task-group-creation-requested.yml
 * @returns {Promise<void>}
 */
async function taskGroupCreationHandler(message) {
  const {
    taskGroupId,
  } = message.payload;

  const debug = Debug(`${debugPrefix}:taskGroup-handler`);
  debug(`Task group ${taskGroupId} was defined. Creating group status...`);

  const {
    sha,
    eventType,
    installationId,
    organization,
    repository,
  } = await this.context.Builds.load({taskGroupId});

  const statusContext = `${this.context.cfg.app.statusContext} (${eventType.split('.')[0]})`;
  const description = `TaskGroup: Pending (for ${eventType})`;
  const target_url = libUrls.ui(this.context.cfg.taskcluster.rootUrl, `/task-group-inspector/#/${taskGroupId}`);

  // Authenticating as installation.
  const instGithub = await this.context.github.getInstallationGithub(installationId);

  await instGithub.repos.createStatus({
    owner: organization,
    repo: repository,
    sha,
    state: 'pending',
    target_url,
    description,
    context: statusContext,
  });
}

/**
 * When the task was defined, post the initial status to github
 * checks api function
 *
 * @param message - taskDefined exchange message
 *   https://docs.taskcluster.net/docs/reference/platform/taskcluster-queue/references/events#taskDefined
 * @returns {Promise<void>}
 */
async function taskDefinedHandler(message) {
  const {taskGroupId, taskId} = message.payload.status;

  const debug = Debug(`${debugPrefix}:task-handler`);
  debug(`Task was defined for task group ${taskGroupId}. Creating status for task ${taskId}...`);

  const {
    organization,
    repository,
    sha,
    eventType,
    installationId,
  } = await this.context.Builds.load({taskGroupId});

  const taskDefinition = await this.queueClient.task(taskId);
  debug(`Initial status. Got task build from DB and task definition for ${taskId} from Queue service`);

  // Authenticating as installation.
  const instGithub = await this.context.github.getInstallationGithub(installationId);

  debug(`Authenticated as installation. Creating check run for task ${taskId}, task group ${taskGroupId}`);

  const checkRun = await instGithub.checks.create({
    owner: organization,
    repo: repository,
    name: `${taskDefinition.metadata.name}`,
    head_sha: sha,
    output: {
      title: `${this.context.cfg.app.statusContext} (${eventType.split('.')[0]})`,
      summary: `${taskDefinition.metadata.description}`,
      text: `[Task group](${libUrls.ui(this.context.cfg.taskcluster.rootUrl, `/groups/${taskGroupId}`)})`,
    },
    details_url: libUrls.ui(
      this.context.cfg.taskcluster.rootUrl,
      `/groups/${taskGroupId}/tasks/${taskId}/details`
    ),
  }).catch(async (err) => {
    await this.createExceptionComment({instGithub, organization, repository, sha, error: err});
    throw err;
  });

  debug(`Created check run for task ${taskId}, task group ${taskGroupId}. Now updating data base`);

  await this.context.CheckRuns.create({
    taskGroupId,
    taskId,
    checkSuiteId: checkRun.data.check_suite.id.toString(),
    checkRunId: checkRun.data.id.toString(),
  }).catch(async (err) => {
    await this.createExceptionComment({instGithub, organization, repository, sha, error: err});
    throw err;
  });

  await this.context.ChecksToTasks.create({
    taskGroupId,
    taskId,
    checkSuiteId: checkRun.data.check_suite.id.toString(),
    checkRunId: checkRun.data.id.toString(),
  }).catch(async (err) => {
    await this.createExceptionComment({instGithub, organization, repository, sha, error: err});
    throw err;
  });

  debug(`Status for task ${taskId}, task group ${taskGroupId} created`);
}
