import Error "mo:core/Error";
import List "mo:core/List";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Queue "mo:core/Queue";

import PT "mo:promtracker";

import HTTP "./http";

persistent actor class NotificationCanister(worker : Principal) = self {

  let CONST = {
    vapidPublicKey = "BHwsFW3GXWkq7v0U_QM3yF43-4U8bjn0Nfdc3tl4BuX3CkzZv9T3df84QHB8PABj5m34y3YRByQfHgC_uHNFYQ4";
  };

  type Application = {
    manager : Principal;
    subscriptions : Map.Map<Principal, List.List<Subscription>>;
  };

  type Subscription = {
    endpoint : Text;
    expirationTime : ?Nat;
    keys : {
      p256dh : Text;
      auth : Text;
    };
  };

  type Vapid = {
    subject : Text;
    publicKey : Text;
    privateKey : Text;
  };

  type NotificationBody = {
    title : Text;
    content : Text;
    url : ?Text;
  };

  type Notification = {
    subscription : Subscription;
    body : NotificationBody;
  };

  let applications : Map.Map<Principal, Application> = Map.empty();
  let notificationsQueue : Queue.Queue<Notification> = Queue.empty();

  var ptData : PT.StableData = null;
  transient let pt = PT.PromTracker("", 65);

  ignore pt.addPullValue("applications_count", "", func() = Map.size(applications));
  transient let subscriptionsCount = pt.addCounter("subscriptions_count", "", true);
  transient let totalMessages = pt.addCounter("total_messages", "", true);
  transient let sentMessages = pt.addCounter("sent_messages", "", true);
  ignore pt.addPullValue("messages_in_queue", "", func() = Queue.size(notificationsQueue));

  pt.unshare(ptData);

  system func preupgrade() {
    ptData := pt.share();
  };

  public query func http_request(req : HTTP.HttpRequest) : async HTTP.HttpResponse {
    let ?path = Text.split(req.url, #char '?').next() else return HTTP.render400();
    switch (req.method, path) {
      case ("GET", "/metrics") pt.renderExposition("canister=\"" # PT.shortName(self) # "\"") |> HTTP.renderPlainText(_);
      case (_) HTTP.render400();
    };
  };

  // end user interface
  public query func getVapidPublicKey() : async Text = async CONST.vapidPublicKey;

  public shared ({ caller }) func subscribe(application : Principal, subscription : Subscription) {
    let ?app = Map.get(applications, Principal.compare, application) else throw Error.reject("Application not found");
    switch (Map.get(app.subscriptions, Principal.compare, caller)) {
      case (?list) {
        switch (List.findIndex<Subscription>(list, func(item) = item.endpoint == subscription.endpoint)) {
          case (?idx) List.put<Subscription>(list, idx, subscription);
          case (null) {
            List.add(list, subscription);
            subscriptionsCount.add(1);
          };
        };
      };
      case (null) {
        let l = List.fromArray<Subscription>([subscription]);
        Map.add(app.subscriptions, Principal.compare, caller, l);
        subscriptionsCount.add(1);
      };
    };
  };

  public shared ({ caller }) func unsubscribe(application : Principal, endpoint : Text) {
    let ?app = Map.get(applications, Principal.compare, application) else throw Error.reject("Application not found");
    switch (Map.get(app.subscriptions, Principal.compare, caller)) {
      case (?list) {
        let listUpd = List.filter(list, func(item) = item.endpoint != endpoint);
        if (List.isEmpty(listUpd)) {
          Map.remove(app.subscriptions, Principal.compare, caller);
        } else {
          Map.add(app.subscriptions, Principal.compare, caller, listUpd);
        };
        subscriptionsCount.sub(List.size(list) - List.size(listUpd));
      };
      case (null) {};
    };
  };

  public shared ({ caller }) func unsubscribeAll(application : Principal) {
    let ?app = Map.get(applications, Principal.compare, application) else throw Error.reject("Application not found");
    switch (Map.get(app.subscriptions, Principal.compare, caller)) {
      case (?list) {
        Map.remove(app.subscriptions, Principal.compare, caller);
        let count = List.size(list);
        if (count > 0) {
          subscriptionsCount.sub(count);
        };
      };
      case (null) {};
    };
  };

  // admin interface
  public shared ({ caller }) func registerApplication(manager : Principal) {
    if (not Principal.isController(caller)) {
      throw Error.reject("Only controllers can register application");
    };
    if (Map.containsKey(applications, Principal.compare, manager)) {
      throw Error.reject("Already registered");
    };
    let app : Application = {
      manager;
      subscriptions = Map.empty();
    };
    Map.add(applications, Principal.compare, manager, app);
  };

  public shared ({ caller }) func deregisterApplication(manager : Principal) {
    if (not Principal.isController(caller)) {
      throw Error.reject("Only controllers can register application");
    };
    let ?app = Map.get(applications, Principal.compare, manager) else return;
    var subscriptionsAmount = 0;
    for (subList in Map.values(app.subscriptions)) {
      subscriptionsAmount += List.size(subList);
    };
    subscriptionsCount.sub(subscriptionsAmount);
    Map.remove(applications, Principal.compare, manager);
  };

  // app owner interface
  public shared ({ caller }) func sendNotification(user : Principal, body : NotificationBody) : async Nat {
    let ?app = Map.get(applications, Principal.compare, caller) else throw Error.reject("Caller does not have any application registered");
    let ?userSubscriptions = Map.get(app.subscriptions, Principal.compare, user) else return 0;
    for (subscription in List.values(userSubscriptions)) {
      Queue.pushBack(notificationsQueue, { subscription; body });
    };
    let sentNotifications = List.size(userSubscriptions);
    totalMessages.add(sentNotifications);
    sentNotifications;
  };

  // worker interface
  public shared query ({ caller }) func isQueueEmpty() : async Bool {
    assert caller == worker;
    Queue.isEmpty(notificationsQueue);
  };

  public shared ({ caller }) func collect() : async [Notification] {
    assert caller == worker;
    let ret : List.List<Notification> = List.empty();
    label l while (List.size(ret) < 100) {
      switch (Queue.popFront(notificationsQueue)) {
        case (?n) List.add(ret, n);
        case (null) break l;
      };
    };
    sentMessages.add(List.size(ret));
    List.toArray(ret);
  };

};
