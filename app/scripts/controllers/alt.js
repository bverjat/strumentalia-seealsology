'use strict';

angular.module('wikiDiverApp')
    .controller('AltCtrl', function ($scope, $http, $log, $timeout, $interval, $window) {
        var regex = /en\.wikipedia\.org\/wiki\/.+/; // regex to match candidates

        $scope.stopWords = [
            'list of',
            'index of',
            'categories of',
            'portal',
            'disambiguation',
            'outline of',
            'Wikipedia:',
            'Category:',
            'File:',
            'wikisource:'
        ];

        $scope.query = '';//http://en.wikipedia.org/wiki/God\nhttp://en.wikipedia.org/wiki/Devil\n';
        $scope.depth = 2;
        $scope.getParents = true;
        $scope.maxQueries = 20;
        $scope.cacheHours = 24;
        $scope.sigma = undefined;
        $scope.colors = ['#de2d26', '#fc9272', '#081d58','#253494','#225ea8','#1d91c0','#41b6c4','#7fcdbb','#c7e9b4','#edf8b1','#ffffd9'];

        $scope.init = function(){
            $scope.alert = false;
            $scope.stopped = false;
            $scope.notFound = [];
            $scope.stoppedPages = [];
            $scope.nodes = [];
            $scope.edges = [];
            $scope.parentsPending = 0;
            $scope.pending = 0;
            $scope.resolved = 0;
            $scope.queue = [];
            $scope.running = 0;
            $scope.processes = [];
        };
        $scope.init();

        $scope.cacheLinks = {};
        var yest = Math.floor(new Date() / 1000) - $scope.cacheHours * 3600;
        try {
            Object.keys(localStorage).forEach(function(k){
                if (k.indexOf('seeAlsology-update-') !== 0) return;
                var p = k.replace('seeAlsology-update-', 'seeAlsology-'),
                    u = p.replace('seeAlsology-', '');
                if (parseInt(localStorage.getItem(k)) < yest){
                    localStorage.removeItem(k);
                    localStorage.removeItem(p);
                } else $scope.cacheLinks[u] = localStorage.getItem(p).split('|');
            });
        } catch(e){}
        $scope.cacheLinksEmpty = !Object.keys($scope.cacheLinks).length;

        function cache(pageLink, links){
            links = links || [];
            $scope.cacheLinks[pageLink] = links;
            $scope.cacheLinksEmpty = false;
            try {
                localStorage.setItem('seeAlsology-' + pageLink, links.join('|'));
                localStorage.setItem('seeAlsology-update-' + pageLink, Math.floor(new Date() / 1000));
            } catch(e){}
        }

        $scope.clearCache = function(){
            Object.keys(localStorage).forEach(function(k){
                localStorage.removeItem(k);
            });
            $scope.cacheLinks = {};
            $scope.cacheLinksEmpty = true;
        };

        $scope.toggleParents = function(){
            $scope.getParents = !$scope.getParents;
        };

        $scope.startCrawl = function(){
            $log.debug('starting crawling for', $scope.query.split('\n').length, 'pages');
            $scope.init();
            $scope.doneParents = {};
            $scope.edgesIndex = {};

            // Clear and init graph
            if ($scope.sigma) $scope.sigma.kill();
            $scope.sigma = new sigma({
                container: 'sigma',
                settings: {
                    labelThreshold: 5,
                    singleHover: true,
                    minNodeSize: 2
                }
            }).configForceAtlas2({
                adjustSizes: true,
                strongGravityMode: true,
                slowDown: 20
            });

            // Draw sigma legend
            $('.sigma-legend').empty();
            $scope.colors.forEach(function(c, i){
                $('.sigma-legend').append(
                  '<span>' +
                     '<div style="background-color: ' + c + '"></div>' +
                    '&nbsp;&nbsp;' + (i ? 'level ' + (i-2) : 'seeds') +
                  '</span>'
                );
            });


            // Links to wikipages on click graph nodes
            $scope.sigma.bind('clickNode', function(e) {
                $window.open($scope.wikiLink(e.data.node.id), '_blank');
            });

            // Check query
            if ($scope.query.trim() !== '') {
                var errors = [],
                    listOfPages = $scope.query.split('\n'),
                    validPages = [];

                // check for integrity
                validPages = listOfPages.filter(function(d) {
                    if (d.trim() === '') return false;

                    $log.info('checking', d, regex.test(d)? 'is a wikipedia page': 'is not a wiki page ...');

                    if (regex.test(d)) return d;
                    else errors.push(d);
                });

                $log.debug('valid wikipedia pages:',validPages, '/', listOfPages, 'n. error pages:', errors.length);

                // Start crawl on pages from query
                if (!errors.length){
                    $timeout(function(){
                        $window.scrollTo(0, document.getElementById('crawl-button').offsetTop - 12);
                    }, 50);

                    validPages.forEach(function(e){
                        getRelatives(e, 0, true);
                    });
                }
                // or report errors
                else {
                    $log.error('Not valid wikipedia pages: ', errors);
                    $scope.alert = true;
                }
            } else {
                $log.error('Empty Query!');
                $scope.alert = true;
            }
        };

        function linkToTitle(t){
            return decodeURIComponent(t).replace(/_/g, ' ');
        }
        function titleToLink(t){
            return encodeURIComponent(t.replace(/ /g, '_'));
        }
        $scope.wikiLink = function(t){
            return 'http://en.wikipedia.org/wiki/' + titleToLink(t);
        };

        // Filter links to pages matching stopWords
        function filterStopWords(links){
            return links.filter(function(l){
                if ($scope.stopWords.some(function(s){
                    return l.toLowerCase().indexOf(s.text.toLowerCase()) !== -1;
                })) {
                    if ($scope.stoppedPages.indexOf(l) === -1)
                        $scope.stoppedPages.push(l);
                    return false;
                } else return !!l.trim();
            });
        }

        // Declare when page not found or section "SeeAlso" misses
        function notFound(pageLink, updateResolved){
            cache(pageLink, ['#NOT-FOUND#']);
            if ($scope.notFound.indexOf(linkToTitle(pageLink)) === -1 && updateResolved)
                $scope.notFound.push(linkToTitle(pageLink));
            if (updateResolved) $scope.resolved++;
            else $scope.parentsPending--;
            $scope.running--;
        }

        // Grab a page's SeeAlso links
        function downloadPageSeeAlsoLinks(pageLink, callback, updateResolved){
            // Use existing cache
            if ($scope.cacheLinks[pageLink]) {
                if ($scope.cacheLinks[pageLink][0] === '#NOT-FOUND#')
                    notFound(pageLink, updateResolved);
                else callback(filterStopWords($scope.cacheLinks[pageLink]));

            // or find the page's SeeAlso section from API
            } else $http.jsonp('http://en.wikipedia.org/w/api.php?action=parse&page=' + pageLink + '&prop=sections&format=json&redirects&callback=JSON_CALLBACK')
            .success(function(data){
                if (!data.parse) return notFound(pageLink, updateResolved);

                var section = null;
                data.parse.sections.forEach(function(e){
                    if (e.line === 'See also') section = e.index;
                });
                if (!section) return notFound(pageLink, updateResolved);

                // Grab page's SeeAlso section from API
                $http.jsonp('http://en.wikipedia.org/w/api.php?format=json&action=query&prop=revisions&titles='+ pageLink +'&rvprop=content&rvsection='+ section +'&redirects&callback=JSON_CALLBACK')
                .success(function(linksData){
                    // Collect links from the section content
                    var o = linksData.query.pages[Object.keys(linksData.query.pages)[0]].revisions[0]['*'],
                        regex = /\[\[(.*?)\]\]/g,
                        matches = regex.exec(o),
                        links = [];
                    while (matches){
                        links.push(matches[1].split('|')[0]);
                        matches = regex.exec(o);
                    }
                    cache(pageLink, links);
                    callback(filterStopWords(links));
                }).error(function(e){
                    $log.error('Could not get content of SeeAlso section from API for', pageLink, e);
                    notFound(pageLink, updateResolved);
                });
            }).error(function(e){
                $log.error('Could not get sections from API for', pageLink, e);
                notFound(pageLink, updateResolved);
            });
        }

        // Add a page to the corpus
        function addNode(pageName, level, seed){
            var existingNode = $scope.nodes.filter(function(e){
                return e.name === pageName;
            });
            if (existingNode.length)
                existingNode[0].level = Math.min(level, existingNode[0].level);
            else {
                $scope.nodes.push({
                    name: pageName,
                    level: level,
                    seed: !!seed
                });
                $scope.sigma.graph.addNode({
                    id: pageName,
                    label: pageName,
                    x: Math.random(),
                    y: Math.random(),
                    size: 1,
                    level: level,
                    seed: !!seed,
                    color: $scope.colors[seed ? 0 : level+2]
                });
            }
        }

        // Add a SeeAlso link between two pages to the corpus
        function addEdge(source, target, ind){
            addNode(source, ind-1);
            addNode(target, ind);

            var edgeId = source + '->' + target;
            if ($scope.edgesIndex[edgeId]) return;
            $scope.edgesIndex[edgeId] = true;
            $scope.edges.push({source: source, target: target, index: ind});

            $scope.sigma.graph.addEdge({
                id: edgeId,
                source: source,
                target: target,
                color: '#ccc'
            });
            $scope.sigma.graph.nodes(source).size = $scope.sigma.graph.degree(source);
            $scope.sigma.graph.nodes(target).size = $scope.sigma.graph.degree(target);
        }

        // Add a page to the corpus and find its parents and sons
        function getRelatives(page, ind, seed){
            if ($scope.stopped) return;
            $scope.pending++;
            var link = '',
                rgx = /wiki\/(.+)/g;
            if (seed){
                link = rgx.exec(page)[1];
                addNode(linkToTitle(link), 0, seed);
            } else link = titleToLink(page.name);
            $scope.queue.unshift({method: getSons, args: [link, ind]});
            if ($scope.getParents) getParents(link, ind);
        }

        // Get a page's sons
        function getSons(page, ind){
            var sons = [];

            downloadPageSeeAlsoLinks(page, function(links){
                $scope.sigma.killForceAtlas2();
                links.forEach(function(d){
                    addEdge(linkToTitle(page), linkToTitle(d), ind+1);
                    sons.push({name: d, index: ind+1});
                });
                $scope.sigma.startForceAtlas2();

                $scope.resolved++;
                $scope.running--;
                if (ind+1 < $scope.depth){
                    sons.forEach(function(m){
                        getRelatives(m, ind+1);
                    });
                }
            }, true);
        }

        // Get a page's parents
        function getParents(page, ind){
            if ($scope.doneParents[page]) return;
            $scope.doneParents[page] = true;

            // Get backlinks to the page from the API
            $http.jsonp('http://en.wikipedia.org/w/api.php?action=query&bltitle=' + page + '&blnamespace=0&list=backlinks&blredirect&blfilterredir=nonredirects&bllimit=250&format=json&callback=JSON_CALLBACK')
            .success(function(data){
                if(!data.query || !data.query.backlinks) return null;

                filterStopWords(data.query.backlinks.map(function(l){
                    return l.title;
                })).forEach(function(parentPage){
                    if ($scope.stopped) return;
                    $scope.parentsPending++;
                    var parentLink = titleToLink(parentPage);
                    if ($scope.cacheLinks[parentLink] && $scope.cacheLinks[parentLink][0] !== '#NOT-FOUND#') {
                        $scope.processes.push($timeout(function(){
                            validateParentFromLinks(page, parentLink, ind, $scope.cacheLinks[parentLink]);
                            $scope.parentsPending--;
                        }, 0));
                    } else {
                        $scope.queue.push({method: downloadPageSeeAlsoLinks, args: [parentLink, function(links){
                            validateParentFromLinks(page, parentLink, ind, links);
                            $scope.running--;
                            $scope.parentsPending--;
                        }]});
                    }
                });
            }).error(function(e){
                $log.error('Could not get backlinks from API for', page, e);
            });
        }

        // Keep only parent links coming from SeeAlso sections
        function validateParentFromLinks(page, parentLink, ind, links){
            var name = linkToTitle(page),
                check = name.toLowerCase();
            if (links.some(function(l){ return (l.toLowerCase() === check); })){
                $scope.sigma.killForceAtlas2();
                addEdge(linkToTitle(parentLink), name, ind);
                $scope.sigma.startForceAtlas2();
            }
        }


        $scope.downloadJSON = function(){
            var json = angular.toJson({nodes:$scope.nodes,edges:$scope.edges});
            var blob = new Blob([json], {type: 'data:text/json;charset=utf-8' });
            saveAs(blob, 'seealsology-data.json');
        };

        $scope.downloadCSV = function(){

            var csvtxt = 'source\ttarget\tdepth\n';
            $scope.edges.forEach(function(e){
                csvtxt+=(e.source+'\t'+ e.target+'\t'+e.index+'\n');
            });
            var blob = new Blob([csvtxt], { type: 'data:text/csv;charset=utf-8' });
            saveAs(blob, 'seealsology-data.tsv');
        };

        $scope.downloadGEXF = function(){
            var gexfDoc = gexf.create({defaultEdgeType: 'directed'});

            gexfDoc.addNodeAttribute({id: 'level', title: 'Level', type: 'integer'});
            gexfDoc.addNodeAttribute({id: 'seed', title: 'Seed', type: 'boolean'});

            $scope.sigma.graph.nodes().forEach(function(n){
                gexfDoc.addNode({
                    id: n.label,
                    label: n.label,
                    attributes: {
                        level: n.level,
                        seed: n.seed
                    },
                    viz: {
                        color: n.color,
                        size: $scope.sigma.graph.degree(n.label),
                        position: {
                            x: n['read_cam0:x'],
                            y: -n['read_cam0:y']
                        }
                    }
                });
            });

            $scope.sigma.graph.edges().forEach(function(e){
                gexfDoc.addEdge({source: e.source, target: e.target});
            });

            var blob = new Blob([gexfDoc.serialize()], { type: 'data:application/xml+gexf;charset=utf-8' });
            saveAs(blob, 'seealsology-data.gexf');
        };

        // Empty queue when free slots
        $interval(function(){
            while (!$scope.stopped && $scope.queue.length > 0 && $scope.running < $scope.maxQueries){
                var task = $scope.queue.shift();
                $scope.running++;
                task.method.apply(null, task.args);
            }
        }, 25);

        $scope.clearQueue = function(){
            $scope.stopped = true;
            $scope.processes.forEach(function(p){
                clearTimeout(p.$$timeoutId);
            });
            $scope.resolved = $scope.pending;
            $scope.parentsPending = $scope.running;
            $scope.queue = [];
        };

        // Stop spatialization when crawl over
        $scope.$watch(
            function(){ return $scope.pending - $scope.resolved + $scope.parentsPending; },
            function(n, o){
                if (!n && n !== o) $timeout(function(){
                    $scope.sigma.stopForceAtlas2();
                }, parseInt(Math.sqrt(10 * $scope.nodes.length) * 100));
            }
        );

        // Zoom buttons
        $scope.zoomSigma = function(positiveZoom){
            var cam = $scope.sigma.cameras[0];
            sigma.misc.animation.camera(
                cam,
                { ratio: cam.ratio * (positiveZoom ? 1/1.5 : 1.5) },
                { duration: 150 }
            );
        };
        $scope.recenterSigma = function(){
            sigma.misc.animation.camera(
                $scope.sigma.cameras[0],
                {x: 0, y: 0, angle: 0, ratio: 1},
                { duration: 150 }
            );
        };


        // Debug
        //$interval(function(){ $log.debug('Queue:', $scope.queue.length, 'Running:', $scope.running, 'Resolved:', $scope.resolved, 'Pending:', $scope.pending, 'ParentsPending:', $scope.parentsPending); }, 2000);

/* TODO
    - check language, validate and adapt
    - append seeds afterwards
*/

    });


