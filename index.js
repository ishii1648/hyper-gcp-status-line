const { execFile } = require('child_process');
const rp = require('request-promise');
const RequestError = require('request-promise/errors').RequestError;
const cheerio = require('cheerio');
const color = require('color');

const configuration = {
    gcloudBinary: 'gcloud',
    kubectlBinary: 'kubectl',
    timeBetweenGcpStatusChecks: 600000
};

const state = {
    gcpProject: 'n/a',
    gceDefaultZone: 'n/a',
    kubernetesContext: 'n/a',
    gcpStatus: 'n/a'
}

const notifications = [];

function setGcpProject() {
    runCommand(configuration.gcloudBinary, ['config', 'get-value', 'project']).then(project => {
        state.gcpProject = project;
    }).catch(error => {
        notifications.push(error);
        state.gcpProject = 'n/a';
    })
}

function setGceDefaultZone() {
    runCommand(configuration.gcloudBinary, ['config', 'get-value', 'compute/zone']).then(zone => {
        state.gceDefaultZone = zone;
    }).catch(error => {
        notifications.push(error);
        state.gceDefaultZone = 'n/a';
    })
}

function setKubernetesContext() {
    runCommand(configuration.kubectlBinary, ['config', 'current-context']).then(context => {
        runCommand(configuration.kubectlBinary, ['config', 'view', '--minify', '--output', 'jsonpath={..namespace}']).then(namespace => {
            state.kubernetesContext = context + ' (' + namespace + ')';
        }).catch(() => {
            state.kubernetesContext = context + ' (default)';
        })
    }).catch(error => {
        notifications.push(error);
        state.kubernetesContext = 'n/a';
    })
}

function setConfiguration() {
    setGcpProject();
    setGceDefaultZone();
    setKubernetesContext();
}

function setGcpStatus() {
    rp({ uri: 'https://status.cloud.google.com/', transform: function (body) { return cheerio.load(body); }}).then(function ($) {
        state.gcpStatus = $('.status').text().trim();
    }).catch(RequestError, function(error) {
        // RequestError is most likely due to user having no connectivity, so do nothing
        state.gcpStatus = 'n/a';
    }).catch(function (error) {
        notifications.push(error);
        state.gcpStatus = 'n/a';
    })
}

function runCommand(command, options) {
    return new Promise((resolve, reject) => {
        execFile(command, options, (error, stdout, stderr) => {
            if (error) {
                reject(error);
            }
            if (stdout.trim() == '') {
                reject('stdout was empty');
            }
            resolve(stdout.trim());
        })
    })
}

exports.reduceUI = (state, { type, config }) => {
    switch (type) {
        case 'CONFIG_LOAD':
        case 'CONFIG_RELOAD': {
            Object.assign(configuration, config.hyperGcpStatusLine);
        }
    }

    return state;
}

exports.decorateConfig = (config) => {
    const colors = {
        foreground: config.foregroundColor || '#fff',
        background: color(config.backgroundColor || '#000').lighten(0.3).string()
    };

    return Object.assign({}, config, {
        css: `
            ${config.css || ''}
            .terms_terms {
                margin-bottom: 30px;
            }
            .hyper-gcp-status-line {
                display: flex;
                justify-content: flex-start;
                position: absolute;
                bottom: 0;
                left: 0;
                right: 0;
                z-index: 100;
                font-size: 12px;
                height: 30px;
                padding: 5px 0 0 10px;
                color: ${colors.foreground};
                background-color: ${colors.background};
            }
            .hyper-gcp-status-line .item {
                padding: 2px 15px 0 25px;
                cursor: default;
            }
            .hyper-gcp-status-line .item:last-child {
                margin-left: auto;
            }
            .hyper-gcp-status-line .gcp-project {
                background: url(${__dirname}/icons/gcp.svg) no-repeat;
            }
            .hyper-gcp-status-line .gce-default-zone {
                background: url(${__dirname}/icons/gce.svg) no-repeat;
            }
            .hyper-gcp-status-line .kubernetes-context {
                background: url(${__dirname}/icons/kubernetes.svg) no-repeat;
            }
            .hyper-gcp-status-line .gcp-status {
                background: url(${__dirname}/icons/status.svg) no-repeat;
            }
        `
    })
}

exports.decorateHyper = (Hyper, { React, notify }) => {
    return class extends React.PureComponent {
        constructor(props) {
            super(props);
            this.state = {};
        }

        render() {
            const { customChildren } = this.props;
            const existingChildren = customChildren ? customChildren instanceof Array ? customChildren : [customChildren] : [];

            return (
                React.createElement(Hyper, Object.assign({}, this.props, {
                    customInnerChildren: existingChildren.concat(React.createElement('footer', { className: 'hyper-gcp-status-line' },
                        React.createElement('div', { className: 'item gcp-project', title: 'GCP project' }, this.state.gcpProject),
                        React.createElement('div', { className: 'item gce-default-zone', title: 'Compute Engine default zone' }, this.state.gceDefaultZone),
                        React.createElement('div', { className: 'item kubernetes-context', title: 'Kubernetes context and namespace' }, this.state.kubernetesContext),
                        React.createElement('div', { className: 'item gcp-status', title: 'Status information as seen on https://status.cloud.google.com/' }, this.state.gcpStatus)
                    ))
                }))
            );
        }

        componentDidMount() {
            // Check configuration, and kick off timer to watch for updates
            setConfiguration();
            this.repaintInterval = setInterval(() => {
                this.setState(state);
            }, 100);

            // Check GCP status, and kick off timer to do it again in the future
            setGcpStatus();
            this.pollGcpStatusInterval = setInterval(() => {
                setGcpStatus();
            }, configuration.timeBetweenGcpStatusChecks);

            // Monitor queue for errors and warnings
            this.notifyInterval = setInterval(() => {
                if(notifications.length > 0) {
                    notify('hyper-gcp-status-plugin error', notifications.pop());
                }
            }, 100);
        }

        componentWillUnmount() {
            clearInterval(this.repaintInterval);
            clearInterval(this.pollGcpStatusInterval);
            clearInterval(this.notifyInterval);
        }
    };
}

exports.middleware = (store) => (next) => (action) => {
    switch (action.type) {
        case 'SESSION_ADD_DATA':
            if (action.data.indexOf('\n') > 1) {
                setConfiguration();
            }
            break;

        case 'SESSION_SET_ACTIVE':
            setConfiguration();
            break;
    }

    next(action);
}
